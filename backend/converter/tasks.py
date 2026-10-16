import json
import shutil
import tempfile
import zipfile
from datetime import timedelta
from pathlib import Path

import trimesh
from asgiref.sync import async_to_sync
from celery import shared_task
from channels.layers import get_channel_layer
from django.core.files import File
from django.db import transaction
from django.utils import timezone

from .models import ConversionTask, SourceFile
from .lifecycle import release_files
from .conversion import assimp_export, prepare_scene

def publish(task):
    async_to_sync(get_channel_layer().group_send)(
        f"task-{task.id}",
        {"type": "task.progress", "payload": {
            "id": str(task.id), "status": task.status, "progress": task.progress,
            "error_message": task.error_message,
        }},
    )

@shared_task(bind=True)
def convert_task(self, task_id):
    task = ConversionTask.objects.select_related("source_file").filter(id=task_id).first()
    if not task:
        return
    task.status, task.progress, task.error_message = "running", 5, ""
    task.started_at = timezone.now()
    if not ConversionTask.objects.filter(pk=task_id, status="queued").update(
        status=task.status, progress=task.progress, started_at=task.started_at, error_message="",
    ):
        return
    publish(task)
    work_dir = Path(tempfile.mkdtemp(prefix=f"modeldesk-{task.id}-"))
    try:
        output_dir, scene, preview, task.log = prepare_scene(task, work_dir)
        task.progress = 60
        if not ConversionTask.objects.filter(pk=task_id, status="running").update(progress=task.progress, log=task.log):
            return
        publish(task)
        output = output_dir / f"output.{task.target_format}"
        if task.target_format == "glb":
            shutil.copyfile(preview, output)
        elif task.target_format == "gltf":
            shutil.copyfile(scene, output)
        else:
            task.log += assimp_export(scene, output, task.target_format)
        try:
            loaded = trimesh.load(str(preview), force="scene")
            geometries = list(loaded.geometry.values()) if hasattr(loaded, "geometry") else [loaded]
            task.triangle_count = sum(len(mesh.faces) for mesh in geometries if hasattr(mesh, "faces"))
            bounds = loaded.bounds if hasattr(loaded, "bounds") else None
            if bounds is not None:
                task.dimensions = {"x": float(bounds[1][0] - bounds[0][0]), "y": float(bounds[1][1] - bounds[0][1]), "z": float(bounds[1][2] - bounds[0][2])}
        except Exception as analysis_error:
            task.log += f"\nAnalysis warning: {analysis_error}"
        if not ConversionTask.objects.filter(pk=task_id, status="running").exists():
            return
        textured = task.assets.exists() or any(
            path.suffix.lower() in (".png", ".jpg", ".jpeg", ".webp", ".tga")
            for path in output_dir.iterdir()
        )
        if task.target_format in ("gltf", "obj", "fbx") or (textured and task.target_format != "glb"):
            output = work_dir / "output.zip"
            manifest = {
                "model": f"output.{task.target_format}", "preview": "preview.glb",
                "textures": list(task.assets.values("kind", "original_name")),
                "note": "STL/PLY store geometry only. preview.glb preserves materials and attached maps.",
            }
            (output_dir / "manifest.json").write_text(json.dumps(manifest, indent=2))
            with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
                for path in output_dir.rglob("*"):
                    if path.is_file():
                        archive.write(path, path.relative_to(output_dir))
            task.artifact_kind = "zip"
        else:
            task.artifact_kind = "file"
        with transaction.atomic():
            # Use the same source -> task lock order as explicit deletion.
            if not SourceFile.objects.select_for_update().filter(pk=task.source_file_id).first():
                return
            if not ConversionTask.objects.select_for_update().filter(pk=task_id, status="running").first():
                return
            with output.open("rb") as handle:
                task.artifact.save(f"{task.id}{output.suffix}", File(handle), save=False)
            with preview.open("rb") as handle:
                task.preview.save(f"{task.id}-preview.glb", File(handle), save=False)
            task.status, task.progress = "succeeded", 100
            task.finished_at = timezone.now()
            task.artifact_expires_at = task.finished_at + timedelta(minutes=10)
            task.save(update_fields=("artifact", "preview", "artifact_kind", "status", "progress", "log",
                                     "triangle_count", "dimensions", "finished_at", "artifact_expires_at"))
            transaction.on_commit(lambda: publish(task), robust=True)
    except Exception as exc:
        for field in (task.artifact, task.preview):
            if field:
                field.delete(save=False)
        task.status, task.progress = "failed", 0
        task.error_message = str(exc)
        task.finished_at = timezone.now()
        updated = ConversionTask.objects.filter(pk=task_id, status="running").update(
            status=task.status, progress=task.progress, error_message=task.error_message, finished_at=task.finished_at,
        )
        if not updated:
            return
        publish(task)
        raise
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)

@shared_task
def cleanup_expired_artifacts():
    now = timezone.now()
    expired = ConversionTask.objects.filter(artifact_expires_at__lte=now).exclude(artifact=None, preview=None)
    for task_id, source_id in expired.values_list("pk", "source_file_id").iterator():
        with transaction.atomic():
            if not SourceFile.objects.select_for_update().filter(pk=source_id).first():
                continue
            task = ConversionTask.objects.select_for_update().filter(pk=task_id, artifact_expires_at__lte=now).first()
            if not task:
                continue
            files = [(field.storage, field.name) for field in (task.artifact, task.preview) if field]
            task.artifact, task.preview = None, None
            task.save(update_fields=("artifact", "preview"))
            release_files(files)
