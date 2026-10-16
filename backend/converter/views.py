import hashlib
from pathlib import Path
from config.celery import app as celery_app
from django.db import transaction
from django.db.models import Count
from django.http import FileResponse
from django.shortcuts import get_object_or_404
from django.utils import timezone
from rest_framework import status
from rest_framework.parsers import MultiPartParser, FormParser
from rest_framework.response import Response
from rest_framework.views import APIView

from PIL import Image
from .models import FORMATS, TEXTURE_KINDS, ConversionTask, SourceFile, TaskAsset
from .serializers import ConversionTaskSerializer, SourceFileSerializer
from .lifecycle import delete_tasks
from .tasks import convert_task, publish

MAX_BYTES = 200 * 1024 * 1024
MAX_TOTAL_BYTES = 500 * 1024 * 1024
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".tga"}


def validate_assets(request, model):
    assets = []
    names = {model.name.casefold()}
    for field, files in request.FILES.lists():
        if field == "file":
            continue
        if field not in (*TEXTURE_KINDS, "resources"):
            raise ValueError(f"Unknown attachment type: {field}")
        if field != "resources" and len(files) != 1:
            raise ValueError(f"Only one texture is allowed for {field}")
        for file in files:
            name = Path(file.name.replace("\\", "/")).name
            if name.casefold() in names:
                raise ValueError(f"Duplicate attachment filename: {name}")
            names.add(name.casefold())
            if file.size > MAX_BYTES:
                raise ValueError("Maximum attachment size is 200 MB")
            extension = Path(name).suffix.lower()
            if extension not in IMAGE_EXTENSIONS | {".bin", ".mtl"} or (field != "resources" and extension not in IMAGE_EXTENSIONS):
                raise ValueError("Attachments must be PNG, JPG, WebP, TGA, BIN, or MTL")
            if extension in IMAGE_EXTENSIONS:
                try:
                    with Image.open(file) as image:
                        if image.width * image.height > 32_000_000:
                            raise ValueError("Texture resolution exceeds 32 megapixels")
                        image.verify()
                except Exception as exc:
                    raise ValueError(f"Invalid texture image: {name}") from exc
                finally:
                    file.seek(0)
            digest = hashlib.sha256()
            for chunk in file.chunks():
                digest.update(chunk)
            file.seek(0)
            assets.append((field if field != "resources" else "resource", name, file, digest.hexdigest()))
    if len(assets) > 32 or model.size + sum(item[2].size for item in assets) > MAX_TOTAL_BYTES:
        raise ValueError("Use at most 32 attachments and 500 MB per task")
    return assets

class FormatCapabilitiesView(APIView):
    def get(self, request):
        return Response({"formats": [{"id": f, "label": f.upper()} for f in FORMATS], "same_format_conversion": False})

class CurrentUserView(APIView):
    def get(self, request):
        return Response({"id": request.user.pk, "username": request.user.username})

class SourceUploadView(APIView):
    parser_classes = (MultiPartParser, FormParser)

    @transaction.atomic
    def post(self, request):
        uploaded = request.FILES.get("file")
        target = str(request.data.get("target_format", "")).lower()
        if not uploaded:
            return Response({"detail": "file is required"}, status=400)
        if len(request.FILES.getlist("file")) != 1:
            return Response({"detail": "Each task requires exactly one model"}, status=400)
        if uploaded.size > MAX_BYTES:
            return Response({"detail": "Maximum file size is 200 MB"}, status=400)
        extension = Path(uploaded.name).suffix.lower().lstrip(".")
        if extension not in FORMATS or target not in FORMATS:
            return Response({"detail": "Unsupported format"}, status=400)
        if extension == target:
            return Response({"detail": "Source and target formats must differ"}, status=400)
        try:
            assets = validate_assets(request, uploaded)
        except ValueError as exc:
            return Response({"detail": str(exc)}, status=400)
        digest = hashlib.sha256()
        for chunk in uploaded.chunks():
            digest.update(chunk)
        uploaded.seek(0)
        manifest = [(kind, name, checksum) for kind, name, _, checksum in assets]
        input_hash = hashlib.sha256(repr((digest.hexdigest(), sorted(manifest))).encode()).hexdigest()
        source, _ = SourceFile.objects.select_for_update().get_or_create(
            owner=request.user,
            sha256=digest.hexdigest(),
            defaults={"original_name": uploaded.name, "extension": extension, "mime_type": uploaded.content_type or "", "size_bytes": uploaded.size, "file": uploaded},
        )
        reusable = ConversionTask.objects.filter(
            owner=request.user,
            source_file=source,
            target_format=target,
            input_hash=input_hash,
            status="succeeded",
            artifact__isnull=False,
            artifact_expires_at__gt=timezone.now(),
        ).order_by("-finished_at").first()
        if reusable:
            task = ConversionTask.objects.create(
                source_file=source,
                owner=request.user,
                target_format=target,
                status="succeeded",
                progress=100,
                artifact=reusable.artifact.name,
                preview=reusable.preview.name if reusable.preview else None,
                artifact_kind=reusable.artifact_kind,
                input_hash=input_hash,
                artifact_expires_at=reusable.artifact_expires_at,
                triangle_count=reusable.triangle_count,
                dimensions=reusable.dimensions,
                finished_at=timezone.now(),
                log="Reused an existing conversion artifact.",
            )
        else:
            task = ConversionTask.objects.create(source_file=source, owner=request.user, target_format=target, input_hash=input_hash)
        for kind, name, file, checksum in assets:
            TaskAsset.objects.create(task=task, kind=kind, original_name=name, file=file, size_bytes=file.size, sha256=checksum)
        if not reusable:
            transaction.on_commit(lambda: convert_task.apply_async(args=[str(task.id)], task_id=str(task.id)))
        return Response(ConversionTaskSerializer(task, context={"request": request}).data, status=status.HTTP_201_CREATED)

class TaskListView(APIView):
    def get(self, request):
        tasks = ConversionTask.objects.filter(owner=request.user).select_related("source_file").prefetch_related("assets").order_by("-created_at")
        return Response(ConversionTaskSerializer(tasks, many=True, context={"request": request}).data)

class TaskDetailView(APIView):
    def get(self, request, task_id):
        task = get_object_or_404(ConversionTask.objects.select_related("source_file"), id=task_id, owner=request.user)
        return Response(ConversionTaskSerializer(task, context={"request": request}).data)

    @transaction.atomic
    def delete(self, request, task_id):
        task = get_object_or_404(ConversionTask, id=task_id, owner=request.user)
        source = get_object_or_404(SourceFile.objects.select_for_update(), pk=task.source_file_id, owner=request.user)
        task = get_object_or_404(ConversionTask.objects.select_for_update().prefetch_related("assets"), pk=task_id, owner=request.user)
        return Response(delete_tasks(source, [task]))

class TaskCancelView(APIView):
    @transaction.atomic
    def post(self, request, task_id):
        task = get_object_or_404(ConversionTask, id=task_id, owner=request.user)
        get_object_or_404(SourceFile.objects.select_for_update(), pk=task.source_file_id, owner=request.user)
        task = get_object_or_404(ConversionTask.objects.select_for_update(), id=task_id, owner=request.user)
        if task.status in ("queued", "running"):
            transaction.on_commit(lambda: celery_app.control.revoke(str(task.id)), robust=True)
            task.status = "canceled"
            task.finished_at = timezone.now()
            task.save(update_fields=("status", "finished_at"))
            transaction.on_commit(lambda: publish(task), robust=True)
        return Response(ConversionTaskSerializer(task, context={"request": request}).data)

class TaskRetryView(APIView):
    @transaction.atomic
    def post(self, request, task_id):
        task = get_object_or_404(ConversionTask, id=task_id, owner=request.user)
        source = get_object_or_404(SourceFile.objects.select_for_update(), pk=task.source_file_id, owner=request.user)
        task = get_object_or_404(ConversionTask.objects.select_for_update(), id=task_id, owner=request.user)
        if task.status not in ("failed", "canceled"):
            return Response({"detail": "Only failed or canceled tasks can be retried"}, status=400)
        retried = ConversionTask.objects.create(
            owner=request.user, source_file=source, target_format=task.target_format, input_hash=task.input_hash,
        )
        TaskAsset.objects.bulk_create([
            TaskAsset(task=retried, kind=asset.kind, original_name=asset.original_name, file=asset.file.name,
                      size_bytes=asset.size_bytes, sha256=asset.sha256)
            for asset in task.assets.all()
        ])
        transaction.on_commit(lambda: convert_task.apply_async(args=[str(retried.id)], task_id=str(retried.id)))
        return Response(ConversionTaskSerializer(retried, context={"request": request}).data, status=201)

class SourceFileListView(APIView):
    def get(self, request):
        sources = SourceFile.objects.filter(owner=request.user).annotate(task_count=Count("tasks")).order_by("-created_at")
        return Response([{
            "id": str(source.id),
            "original_name": source.original_name,
            "extension": source.extension,
            "size_bytes": source.size_bytes,
            "created_at": source.created_at,
            "task_count": source.task_count,
        } for source in sources])

class SourceFileDetailView(APIView):
    def get(self, request, source_id):
        source = get_object_or_404(SourceFile, pk=source_id, owner=request.user)
        tasks = source.tasks.filter(owner=request.user).order_by("-created_at")
        return Response({
            **SourceFileSerializer(source).data,
            "tasks": [{
                "id": str(task.id), "target_format": task.target_format, "status": task.status,
                "created_at": task.created_at,
            } for task in tasks],
        })

    @transaction.atomic
    def delete(self, request, source_id):
        source = get_object_or_404(SourceFile.objects.select_for_update(), pk=source_id, owner=request.user)
        tasks = list(source.tasks.select_for_update().prefetch_related("assets").order_by("-created_at"))
        confirmed_ids = request.data.get("task_ids")
        if not isinstance(confirmed_ids, list) or any(not isinstance(value, str) for value in confirmed_ids):
            return Response({"detail": "Confirm the linked task IDs before deleting this source."}, status=400)
        if set(confirmed_ids) != {str(task.id) for task in tasks}:
            return Response({"detail": "Linked tasks changed. Review the list and confirm again.", "code": "linked_tasks_changed"}, status=409)
        return Response(delete_tasks(source, tasks))

class TaskArtifactView(APIView):
    field = "artifact"

    def get(self, request, task_id):
        task = get_object_or_404(ConversionTask, id=task_id, owner=request.user, status="succeeded")
        file = getattr(task, self.field)
        if not file or (task.artifact_expires_at and task.artifact_expires_at <= timezone.now()) or not file.storage.exists(file.name):
            return Response({"detail": "Artifact has expired."}, status=status.HTTP_410_GONE)
        name = "preview.glb" if self.field == "preview" else f"{Path(task.source_file.original_name).stem}.{'zip' if task.artifact_kind == 'zip' else task.target_format}"
        return FileResponse(file.open("rb"), as_attachment=self.field == "artifact", filename=name,
                            content_type="model/gltf-binary" if self.field == "preview" else None)


class TaskPreviewView(TaskArtifactView):
    field = "preview"
