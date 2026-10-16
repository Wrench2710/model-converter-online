"""Release task-owned files after commit, preserving deduplicated references."""
from django.db import transaction
from django.db.models import Q

from config.celery import app as celery_app
from .models import ConversionTask, SourceFile, TaskAsset


def release_files(files):
    def cleanup():
        for storage, name in files:
            if not name:
                continue
            if (SourceFile.objects.filter(file=name).exists()
                    or TaskAsset.objects.filter(file=name).exists()
                    or ConversionTask.objects.filter(Q(artifact=name) | Q(preview=name)).exists()):
                continue
            storage.delete(name)
    transaction.on_commit(cleanup, robust=True)


def delete_tasks(source, tasks):
    """Caller holds the source row lock until tasks and file references commit."""
    files = []
    ids = [str(task.pk) for task in tasks]
    for task in tasks:
        files.extend((field.storage, field.name) for field in (task.artifact, task.preview) if field)
        files.extend((asset.file.storage, asset.file.name) for asset in task.assets.all())
        if task.status in ("queued", "running"):
            transaction.on_commit(lambda task_id=str(task.pk): celery_app.control.revoke(task_id), robust=True)
    ConversionTask.objects.filter(pk__in=ids).delete()
    source_deleted = not source.tasks.select_for_update().exists()
    if source_deleted:
        files.append((source.file.storage, source.file.name))
        source.delete()
    release_files(files)
    return {"deleted_task_ids": ids, "source_deleted": source_deleted}
