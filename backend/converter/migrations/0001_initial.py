import uuid
from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):
    initial = True
    dependencies = []
    operations = [
        migrations.CreateModel(
            name="SourceFile",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("original_name", models.CharField(max_length=255)),
                ("extension", models.CharField(max_length=10)),
                ("mime_type", models.CharField(blank=True, max_length=120)),
                ("size_bytes", models.BigIntegerField()),
                ("sha256", models.CharField(db_index=True, max_length=64, unique=True)),
                ("file", models.FileField(upload_to="sources/")),
                ("created_at", models.DateTimeField(auto_now_add=True)),
            ],
            options={"indexes": [models.Index(fields=["extension", "created_at"], name="converter_s_extensi_3ccf86_idx")]},
        ),
        migrations.CreateModel(
            name="ConversionTask",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("target_format", models.CharField(max_length=10)),
                ("status", models.CharField(choices=[("queued", "Queued"), ("running", "Running"), ("succeeded", "Succeeded"), ("failed", "Failed"), ("canceled", "Canceled")], db_index=True, default="queued", max_length=16)),
                ("progress", models.PositiveSmallIntegerField(default=0)),
                ("artifact", models.FileField(blank=True, null=True, upload_to="artifacts/")),
                ("artifact_expires_at", models.DateTimeField(blank=True, null=True)),
                ("triangle_count", models.PositiveBigIntegerField(blank=True, null=True)),
                ("dimensions", models.JSONField(blank=True, default=dict)),
                ("error_message", models.TextField(blank=True)),
                ("log", models.TextField(blank=True)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("started_at", models.DateTimeField(blank=True, null=True)),
                ("finished_at", models.DateTimeField(blank=True, null=True)),
                ("source_file", models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name="tasks", to="converter.sourcefile")),
            ],
            options={"indexes": [
                models.Index(fields=["status", "-created_at"], name="converter_s_status_7f84fb_idx"),
                models.Index(fields=["source_file", "target_format"], name="converter_s_source__f5af2b_idx"),
            ]},
        ),
    ]
