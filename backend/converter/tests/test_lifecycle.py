import tempfile
from datetime import timedelta
from pathlib import Path
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.core.files.base import ContentFile
from django.test import TestCase, override_settings
from django.utils import timezone
from rest_framework.test import APIClient

from converter.models import ConversionTask, SourceFile, TaskAsset
from converter.tasks import cleanup_expired_artifacts, convert_task


class LifecycleTests(TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        settings = override_settings(MEDIA_ROOT=directory.name)
        settings.enable()
        self.addCleanup(settings.disable)
        self.revoke = patch("converter.lifecycle.celery_app.control.revoke").start()
        self.addCleanup(patch.stopall)
        self.user = get_user_model().objects.create_user(username="lifecycle@example.com")
        self.client = APIClient()
        self.client.force_authenticate(self.user)
        self.source = SourceFile.objects.create(
            owner=self.user, original_name="plane.obj", extension="obj", sha256="1" * 64,
            size_bytes=8, file=ContentFile(b"source", name="plane.obj"),
        )

    def task(self, **overrides):
        data = dict(owner=self.user, source_file=self.source, target_format="glb", status="succeeded",
                    log="Retained conversion log", artifact_expires_at=timezone.now() + timedelta(minutes=10))
        data.update(overrides)
        task = ConversionTask.objects.create(**data)
        if "artifact" not in overrides:
            task.artifact.save(f"{task.pk}.glb", ContentFile(b"artifact"), save=False)
            task.preview.save(f"{task.pk}-preview.glb", ContentFile(b"preview"), save=False)
            task.save()
        return task

    def asset(self, task):
        return TaskAsset.objects.create(task=task, kind="base_color", original_name="color.png",
                                       file=ContentFile(b"texture", name="color.png"), size_bytes=7, sha256="2" * 64)

    def delete_task(self, task):
        with self.captureOnCommitCallbacks(execute=True):
            return self.client.delete(f"/api/tasks/{task.pk}/")

    def test_last_task_deletion_removes_record_source_attachments_and_files(self):
        task = self.task()
        asset = self.asset(task)
        paths = [Path(field.path) for field in (self.source.file, task.artifact, task.preview, asset.file)]
        with self.captureOnCommitCallbacks(execute=True):
            response = self.client.delete(f"/api/tasks/{task.pk}/")
            self.assertTrue(all(path.exists() for path in paths), "Physical deletion must wait for commit")
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.data["source_deleted"])
        self.assertFalse(ConversionTask.objects.exists())
        self.assertFalse(SourceFile.objects.exists())
        self.assertFalse(TaskAsset.objects.exists())
        self.assertTrue(all(not path.exists() for path in paths))

    def test_shared_source_and_artifacts_survive_until_last_reference_is_deleted(self):
        first = self.task()
        second = self.task(artifact=first.artifact.name, preview=first.preview.name)
        asset = self.asset(first)
        retained = [Path(field.path) for field in (self.source.file, first.artifact, first.preview)]
        asset_path = Path(asset.file.path)
        response = self.delete_task(first)
        self.assertFalse(response.data["source_deleted"])
        self.assertTrue(ConversionTask.objects.filter(pk=second.pk).exists())
        self.assertTrue(all(path.exists() for path in retained))
        self.assertFalse(asset_path.exists())
        self.delete_task(second)
        self.assertTrue(all(not path.exists() for path in retained))

    def test_source_deletion_requires_current_linked_task_snapshot(self):
        first = self.task()
        detail = self.client.get(f"/api/files/{self.source.pk}/")
        self.assertEqual([task["id"] for task in detail.data["tasks"]], [str(first.pk)])
        self.assertEqual(self.client.delete(f"/api/files/{self.source.pk}/", {}, format="json").status_code, 400)
        second = self.task()
        response = self.client.delete(f"/api/files/{self.source.pk}/", {"task_ids": [str(first.pk)]}, format="json")
        self.assertEqual(response.status_code, 409)
        self.assertEqual(ConversionTask.objects.count(), 2)
        self.assertTrue(SourceFile.objects.filter(pk=self.source.pk).exists())
        with self.captureOnCommitCallbacks(execute=True):
            response = self.client.delete(f"/api/files/{self.source.pk}/", {
                "task_ids": [str(first.pk), str(second.pk)],
            }, format="json")
        self.assertEqual(response.status_code, 200)
        self.assertFalse(ConversionTask.objects.exists())
        self.assertFalse(SourceFile.objects.exists())

    def test_source_cascade_cleans_all_assets_and_revokes_active_tasks(self):
        first = self.task(status="running")
        second = self.task(status="queued")
        assets = [self.asset(first), self.asset(second)]
        paths = [Path(field.path) for field in (self.source.file, first.artifact, first.preview,
                                               second.artifact, second.preview, *(asset.file for asset in assets))]
        with self.captureOnCommitCallbacks(execute=True):
            response = self.client.delete(f"/api/files/{self.source.pk}/", {
                "task_ids": [str(first.pk), str(second.pk)],
            }, format="json")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.revoke.call_count, 2)
        self.assertFalse(TaskAsset.objects.exists())
        self.assertTrue(all(not path.exists() for path in paths))

    def test_user_cannot_inspect_or_delete_another_users_source_or_tasks(self):
        task = self.task()
        other = get_user_model().objects.create_user(username="another@example.com")
        self.client.force_authenticate(other)
        self.assertEqual(self.client.get(f"/api/files/{self.source.pk}/").status_code, 404)
        self.assertEqual(self.client.delete(f"/api/files/{self.source.pk}/", {"task_ids": [str(task.pk)]}, format="json").status_code, 404)
        self.assertEqual(self.client.delete(f"/api/tasks/{task.pk}/").status_code, 404)
        self.assertTrue(ConversionTask.objects.filter(pk=task.pk).exists())

    def test_expiry_retains_history_source_maps_logs_and_expiry_time(self):
        task = self.task(artifact_expires_at=timezone.now() - timedelta(seconds=1))
        asset = self.asset(task)
        paths = [Path(task.artifact.path), Path(task.preview.path)]
        with self.captureOnCommitCallbacks(execute=True):
            cleanup_expired_artifacts()
        task.refresh_from_db()
        self.assertEqual(task.log, "Retained conversion log")
        self.assertEqual(task.status, "succeeded")
        self.assertIsNotNone(task.artifact_expires_at)
        self.assertTrue(Path(self.source.file.path).exists())
        self.assertTrue(Path(asset.file.path).exists())
        self.assertTrue(all(not path.exists() for path in paths))
        history = self.client.get("/api/tasks/").data
        self.assertEqual(len(history), 1)
        self.assertIsNone(history[0]["artifact_url"])
        self.assertIsNone(history[0]["preview_url"])

    def test_expiry_preserves_an_artifact_with_an_unexpired_reference(self):
        first = self.task(artifact_expires_at=timezone.now() - timedelta(seconds=1))
        second = self.task(artifact=first.artifact.name, preview=first.preview.name)
        with self.captureOnCommitCallbacks(execute=True):
            cleanup_expired_artifacts()
        second.refresh_from_db()
        self.assertTrue(Path(second.artifact.path).exists())
        self.assertTrue(Path(second.preview.path).exists())

    def test_history_is_not_silently_limited_to_one_hundred_tasks(self):
        ConversionTask.objects.bulk_create([
            ConversionTask(owner=self.user, source_file=self.source, target_format="glb") for _ in range(105)
        ])
        self.assertEqual(len(self.client.get("/api/tasks/").data), 105)
        self.assertEqual(self.client.get("/api/files/").data[0]["task_count"], 105)

    def test_deleted_queued_task_is_ignored_by_worker(self):
        task = self.task(status="queued")
        task_id = str(task.pk)
        self.delete_task(task)
        with patch("converter.tasks.prepare_scene") as prepare:
            convert_task.run(task_id)
        prepare.assert_not_called()
        self.assertFalse(ConversionTask.objects.exists())

    def test_deletion_during_conversion_cannot_resurrect_task_or_output(self):
        task = self.task(status="queued", artifact=None, preview=None)
        task_id = str(task.pk)

        def deleted_while_preparing(*args):
            self.assertEqual(self.delete_task(task).status_code, 200)
            raise FileNotFoundError("Input was explicitly deleted")

        with patch("converter.tasks.publish"), patch("converter.tasks.prepare_scene", side_effect=deleted_while_preparing):
            convert_task.run(task_id)
        self.assertFalse(ConversionTask.objects.exists())
        self.assertFalse(SourceFile.objects.exists())

    def test_canceled_or_completed_task_is_not_started_again(self):
        for status in ("canceled", "succeeded"):
            task = self.task(status=status)
            with patch("converter.tasks.prepare_scene") as prepare:
                convert_task.run(str(task.pk))
            prepare.assert_not_called()

    def test_source_without_tasks_can_be_deleted_after_confirming_empty_list(self):
        path = Path(self.source.file.path)
        with self.captureOnCommitCallbacks(execute=True):
            response = self.client.delete(f"/api/files/{self.source.pk}/", {"task_ids": []}, format="json")
        self.assertEqual(response.status_code, 200)
        self.assertFalse(path.exists())
        self.assertFalse(SourceFile.objects.exists())

    def test_retry_preserves_failed_record_and_reuses_maps_until_last_reference(self):
        original = self.task(status="failed", error_message="Original failure", artifact=None, preview=None)
        asset = self.asset(original)
        asset_path = Path(asset.file.path)
        with patch("converter.views.convert_task.apply_async") as dispatch:
            with self.captureOnCommitCallbacks(execute=True):
                response = self.client.post(f"/api/tasks/{original.pk}/retry/")
            self.assertEqual(response.status_code, 201)
            dispatch.assert_called_once_with(args=[response.data["id"]], task_id=response.data["id"])
        original.refresh_from_db()
        self.assertEqual(original.status, "failed")
        self.assertEqual(original.error_message, "Original failure")
        retried = ConversionTask.objects.get(pk=response.data["id"])
        self.assertNotEqual(retried.pk, original.pk)
        self.assertEqual(retried.status, "queued")
        self.assertEqual(retried.assets.get().file.name, asset.file.name)
        self.delete_task(original)
        self.assertTrue(asset_path.exists())
        self.delete_task(retried)
        self.assertFalse(asset_path.exists())
