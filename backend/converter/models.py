import uuid
from pathlib import Path
from django.db import models

FORMATS = ("glb", "gltf", "obj", "stl", "ply", "fbx")
TEXTURE_KINDS = ("base_color", "normal", "roughness", "metallic", "ao", "emissive")
STATUS_CHOICES = (
    ("queued", "Queued"),
    ("running", "Running"),
    ("succeeded", "Succeeded"),
    ("failed", "Failed"),
    ("canceled", "Canceled"),
)

class SourceFile(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    owner = models.ForeignKey("auth.User", on_delete=models.CASCADE, related_name="source_files")
    original_name = models.CharField(max_length=255)
    extension = models.CharField(max_length=10)
    mime_type = models.CharField(max_length=120, blank=True)
    size_bytes = models.BigIntegerField()
    sha256 = models.CharField(max_length=64, db_index=True)
    file = models.FileField(upload_to="sources/")
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        indexes = [models.Index(fields=("extension", "created_at"), name="converter_s_extensi_3ccf86_idx")]
        constraints = [
            models.UniqueConstraint(fields=("owner", "sha256"), name="unique_source_hash_per_owner"),
        ]

class ConversionTask(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    owner = models.ForeignKey("auth.User", on_delete=models.CASCADE, related_name="conversion_tasks")
    source_file = models.ForeignKey(SourceFile, on_delete=models.PROTECT, related_name="tasks")
    target_format = models.CharField(max_length=10)
    status = models.CharField(max_length=16, choices=STATUS_CHOICES, default="queued", db_index=True)
    progress = models.PositiveSmallIntegerField(default=0)
    artifact = models.FileField(upload_to="artifacts/", blank=True, null=True)
    preview = models.FileField(upload_to="artifacts/", blank=True, null=True)
    artifact_kind = models.CharField(max_length=10, default="file")
    input_hash = models.CharField(max_length=64, blank=True, db_index=True)
    artifact_expires_at = models.DateTimeField(blank=True, null=True)
    triangle_count = models.PositiveBigIntegerField(blank=True, null=True)
    dimensions = models.JSONField(default=dict, blank=True)
    error_message = models.TextField(blank=True)
    log = models.TextField(blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    started_at = models.DateTimeField(blank=True, null=True)
    finished_at = models.DateTimeField(blank=True, null=True)

    class Meta:
        indexes = [
            models.Index(fields=("status", "-created_at"), name="converter_s_status_7f84fb_idx"),
            models.Index(fields=("source_file", "target_format"), name="converter_s_source__f5af2b_idx"),
        ]


def asset_path(instance, filename):
    return f"inputs/{instance.task_id}/{uuid.uuid4().hex}/{Path(filename).name}"


class TaskAsset(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    task = models.ForeignKey(ConversionTask, on_delete=models.CASCADE, related_name="assets")
    kind = models.CharField(max_length=20)
    original_name = models.CharField(max_length=255)
    file = models.FileField(upload_to=asset_path)
    size_bytes = models.BigIntegerField()
    sha256 = models.CharField(max_length=64)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=("task", "original_name"), name="unique_task_asset_name"),
        ]
