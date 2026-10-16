from django.conf import settings
from django.db import migrations, models
import django.db.models.deletion


def assign_existing_records(apps, schema_editor):
    User = apps.get_model(*settings.AUTH_USER_MODEL.split("."))
    SourceFile = apps.get_model("converter", "SourceFile")
    ConversionTask = apps.get_model("converter", "ConversionTask")
    db_alias = schema_editor.connection.alias

    legacy_user, _ = User.objects.using(db_alias).get_or_create(
        username="legacy-import",
        defaults={"is_active": False, "password": "!"},
    )
    SourceFile.objects.using(db_alias).filter(owner__isnull=True).update(owner_id=legacy_user.pk)
    ConversionTask.objects.using(db_alias).filter(owner__isnull=True).update(owner_id=legacy_user.pk)


class Migration(migrations.Migration):
    dependencies = [
        ("converter", "0001_initial"),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.AddField(
            model_name="sourcefile",
            name="owner",
            field=models.ForeignKey(
                null=True,
                on_delete=django.db.models.deletion.CASCADE,
                related_name="source_files",
                to=settings.AUTH_USER_MODEL,
            ),
        ),
        migrations.AddField(
            model_name="conversiontask",
            name="owner",
            field=models.ForeignKey(
                null=True,
                on_delete=django.db.models.deletion.CASCADE,
                related_name="conversion_tasks",
                to=settings.AUTH_USER_MODEL,
            ),
        ),
        migrations.AlterField(
            model_name="sourcefile",
            name="sha256",
            field=models.CharField(db_index=True, max_length=64),
        ),
        migrations.RunPython(assign_existing_records, migrations.RunPython.noop),
        migrations.AlterField(
            model_name="sourcefile",
            name="owner",
            field=models.ForeignKey(
                on_delete=django.db.models.deletion.CASCADE,
                related_name="source_files",
                to=settings.AUTH_USER_MODEL,
            ),
        ),
        migrations.AlterField(
            model_name="conversiontask",
            name="owner",
            field=models.ForeignKey(
                on_delete=django.db.models.deletion.CASCADE,
                related_name="conversion_tasks",
                to=settings.AUTH_USER_MODEL,
            ),
        ),
        migrations.AddConstraint(
            model_name="sourcefile",
            constraint=models.UniqueConstraint(fields=("owner", "sha256"), name="unique_source_hash_per_owner"),
        ),
    ]
