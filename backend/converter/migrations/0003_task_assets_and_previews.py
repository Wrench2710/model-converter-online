from django.db import migrations, models
import django.db.models.deletion
import uuid
import converter.models


class Migration(migrations.Migration):
    dependencies = [("converter", "0002_user_isolation")]

    operations = [
        migrations.AddField(
            model_name="conversiontask",
            name="artifact_kind",
            field=models.CharField(default="file", max_length=10),
        ),
        migrations.AddField(
            model_name="conversiontask",
            name="input_hash",
            field=models.CharField(blank=True, db_index=True, max_length=64),
        ),
        migrations.AddField(
            model_name="conversiontask",
            name="preview",
            field=models.FileField(blank=True, null=True, upload_to="artifacts/"),
        ),
        migrations.CreateModel(
            name="TaskAsset",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("kind", models.CharField(max_length=20)),
                ("original_name", models.CharField(max_length=255)),
                ("file", models.FileField(upload_to=converter.models.asset_path)),
                ("size_bytes", models.BigIntegerField()),
                ("sha256", models.CharField(max_length=64)),
                ("task", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="assets", to="converter.conversiontask")),
            ],
            options={
                "constraints": [
                    models.UniqueConstraint(fields=("task", "original_name"), name="unique_task_asset_name"),
                ],
            },
        ),
    ]
