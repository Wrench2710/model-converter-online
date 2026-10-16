from rest_framework import serializers
from django.utils import timezone
from .models import ConversionTask, SourceFile, TaskAsset

class SourceFileSerializer(serializers.ModelSerializer):
    class Meta:
        model = SourceFile
        fields = ("id", "original_name", "extension", "mime_type", "size_bytes", "sha256", "created_at")

class TaskAssetSerializer(serializers.ModelSerializer):
    class Meta:
        model = TaskAsset
        fields = ("id", "kind", "original_name", "size_bytes")


class ConversionTaskSerializer(serializers.ModelSerializer):
    source_file = SourceFileSerializer(read_only=True)
    artifact_url = serializers.SerializerMethodField()
    preview_url = serializers.SerializerMethodField()
    assets = TaskAssetSerializer(many=True, read_only=True)

    class Meta:
        model = ConversionTask
        fields = ("id", "source_file", "target_format", "status", "progress", "artifact_url", "preview_url", "artifact_kind", "artifact_expires_at", "assets", "triangle_count", "dimensions", "error_message", "log", "created_at", "started_at", "finished_at")

    def get_artifact_url(self, obj):
        return self.resource_url(obj, "artifact")

    def get_preview_url(self, obj):
        return self.resource_url(obj, "preview")

    def resource_url(self, obj, field):
        if not getattr(obj, field) or (obj.artifact_expires_at and obj.artifact_expires_at <= timezone.now()):
            return None
        request = self.context.get("request")
        path = f"/api/tasks/{obj.id}/{field}/"
        return request.build_absolute_uri(path) if request else path
