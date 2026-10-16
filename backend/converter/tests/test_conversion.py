import io
import json
import tempfile
import zipfile
from pathlib import Path
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.core.files.base import ContentFile
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import TestCase, override_settings
from PIL import Image
from rest_framework.test import APIClient

from converter.models import ConversionTask
from converter.tasks import cleanup_expired_artifacts, convert_task


OBJ = b"""o Plane
v -1 0 0
v 1 0 0
v 0 2 0
vt 0 0
vt 1 0
vt 0.5 1
vn 0 0 1
f 1/1/1 2/2/1 3/3/1
"""


def image_upload(name="color.png", color=(200, 60, 30)):
    content = io.BytesIO()
    Image.new("RGB", (2, 2), color).save(content, format="PNG")
    return SimpleUploadedFile(name, content.getvalue(), content_type="image/png")


class ConversionTests(TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.settings_override = override_settings(MEDIA_ROOT=self.directory.name)
        self.settings_override.enable()
        self.addCleanup(self.settings_override.disable)
        self.addCleanup(self.directory.cleanup)
        self.user = get_user_model().objects.create_user(username="models@example.com")
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def upload(self, target="glb", filename="plane.obj", model_data=OBJ, **extra):
        with patch("converter.views.convert_task.apply_async"):
            return self.client.post("/api/files/upload/", {
                "file": SimpleUploadedFile(filename, model_data),
                "target_format": target, **extra,
            }, format="multipart")

    def test_upload_keeps_texture_metadata_and_changes_reuse_key(self):
        response = self.upload(base_color=image_upload())
        self.assertEqual(response.status_code, 201)
        self.assertEqual(len(response.data.get("assets", [])), 1)
        self.assertEqual(response.data["assets"][0]["kind"], "base_color")
        first = ConversionTask.objects.get(id=response.data["id"])
        second = self.upload(base_color=image_upload(color=(30, 100, 200)))
        self.assertNotEqual(first.input_hash, ConversionTask.objects.get(id=second.data["id"]).input_hash)
        self.assertEqual(first.source_file_id, ConversionTask.objects.get(id=second.data["id"]).source_file_id)

    def test_invalid_texture_is_rejected_before_task_creation(self):
        response = self.upload(normal=SimpleUploadedFile("fake.png", b"not an image"))
        self.assertEqual(response.status_code, 400)
        self.assertFalse(ConversionTask.objects.exists())

    def test_textured_glb_is_self_contained_and_has_authenticated_preview(self):
        response = self.upload(base_color=image_upload(), normal=image_upload("normal.png", (128, 128, 255)),
                               roughness=image_upload("rough.png", (90, 90, 90)),
                               metallic=image_upload("metal.png"), ao=image_upload("ao.png"),
                               emissive=image_upload("emissive.png"))
        task_id = response.data["id"]
        with patch("converter.tasks.publish"):
            convert_task.run(task_id)
        task = ConversionTask.objects.get(pk=task_id)
        self.assertEqual(task.status, "succeeded")
        data = Path(task.artifact.path).read_bytes()
        self.assertEqual(data[:4], b"glTF")
        length = int.from_bytes(data[12:16], "little")
        document = json.loads(data[20:20 + length])
        self.assertTrue(document["images"])
        self.assertTrue(all("uri" not in image and "bufferView" in image for image in document["images"]))
        material = document["materials"][0]
        self.assertIn("baseColorTexture", material["pbrMetallicRoughness"])
        self.assertIn("metallicRoughnessTexture", material["pbrMetallicRoughness"])
        self.assertIn("normalTexture", material)
        self.assertIn("occlusionTexture", material)
        self.assertIn("emissiveTexture", material)
        detail = self.client.get(f"/api/tasks/{task_id}/").data
        self.assertTrue(detail["preview_url"])
        preview = self.client.get(detail["preview_url"])
        self.assertEqual(preview.status_code, 200)
        preview.close()
        other = get_user_model().objects.create_user(username="other@example.com")
        self.client.force_authenticate(other)
        self.assertEqual(self.client.get(detail["preview_url"]).status_code, 404)
        self.assertEqual(self.client.get(f"/api/tasks/{task_id}/artifact/").status_code, 404)
        self.client.force_authenticate(None)
        self.assertEqual(self.client.get(detail["preview_url"]).status_code, 401)

    def test_multifile_outputs_include_materials_and_all_maps(self):
        for target in ("gltf", "fbx", "stl", "ply"):
            with self.subTest(target=target):
                response = self.upload(target=target, base_color=image_upload(),
                                       metallic=image_upload("metal.png", (180, 180, 180)))
                with patch("converter.tasks.publish"):
                    convert_task.run(response.data["id"])
                task = ConversionTask.objects.get(pk=response.data["id"])
                self.assertEqual(task.artifact_kind, "zip")
                with zipfile.ZipFile(task.artifact.path) as archive:
                    names = archive.namelist()
                    self.assertIn(f"output.{target}", names)
                    self.assertIn("preview.glb", names)
                    self.assertTrue(any(name.endswith("color.png") for name in names))
                    self.assertTrue(any(name.endswith("metal.png") for name in names))
        response = self.upload(target="obj", filename="plane.ply", model_data=b"ply\nformat ascii 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\nelement face 1\nproperty list uchar int vertex_indices\nend_header\n-1 0 0\n1 0 0\n0 2 0\n3 0 1 2\n")
        with patch("converter.tasks.publish"):
            convert_task.run(response.data["id"])
        task = ConversionTask.objects.get(pk=response.data["id"])
        self.assertEqual(task.artifact_kind, "zip")
        with zipfile.ZipFile(task.artifact.path) as archive:
            self.assertIn("output.obj", archive.namelist())

    def test_cleanup_expires_preview_and_artifact_but_keeps_input_metadata(self):
        from datetime import timedelta
        from django.utils import timezone
        response = self.upload(base_color=image_upload())
        with patch("converter.tasks.publish"):
            convert_task.run(response.data["id"])
        task = ConversionTask.objects.get(pk=response.data["id"])
        paths = [Path(task.artifact.path), Path(task.preview.path)]
        task.artifact_expires_at = timezone.now() - timedelta(seconds=1)
        task.save()
        self.assertEqual(self.client.get(f"/api/tasks/{task.id}/preview/").status_code, 410)
        with self.captureOnCommitCallbacks(execute=True):
            cleanup_expired_artifacts()
        task.refresh_from_db()
        self.assertFalse(task.artifact)
        self.assertFalse(task.preview)
        self.assertTrue(task.assets.exists())
        self.assertTrue(all(not path.exists() for path in paths))

    def test_uvless_models_do_not_silently_claim_texture_support(self):
        with patch("converter.views.convert_task.apply_async"):
            response = self.client.post("/api/files/upload/", {
                "file": SimpleUploadedFile("plane.obj", b"v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n"),
                "target_format": "glb", "base_color": image_upload(),
            }, format="multipart")
        with patch("converter.tasks.publish"):
            with self.assertRaisesRegex(RuntimeError, "UV"):
                convert_task.run(response.data["id"])

    def test_embedded_textures_survive_glb_to_obj(self):
        response = self.upload(base_color=image_upload())
        with patch("converter.tasks.publish"):
            convert_task.run(response.data["id"])
        original = ConversionTask.objects.get(pk=response.data["id"])
        response = self.upload(target="obj", filename="embedded.glb",
                               model_data=Path(original.artifact.path).read_bytes())
        with patch("converter.tasks.publish"):
            convert_task.run(response.data["id"])
        task = ConversionTask.objects.get(pk=response.data["id"])
        with zipfile.ZipFile(task.artifact.path) as archive:
            self.assertIn("output.obj", archive.namelist())
            self.assertIn("output.mtl", archive.namelist())
            self.assertIn(b"map_Kd", archive.read("output.mtl"))
            self.assertTrue(any(name.endswith(".png") for name in archive.namelist()))

    def test_external_gltf_bin_resources_are_kept_with_the_model(self):
        response = self.upload(target="gltf", base_color=image_upload())
        with patch("converter.tasks.publish"):
            convert_task.run(response.data["id"])
        task = ConversionTask.objects.get(pk=response.data["id"])
        with zipfile.ZipFile(task.artifact.path) as archive:
            document = json.loads(archive.read("output.gltf"))
            resources = [SimpleUploadedFile(name, archive.read(name)) for name in archive.namelist()
                         if name.endswith((".bin", ".png", ".jpg"))]
            data = json.dumps(document).encode()
        response = self.upload(target="glb", filename="external.gltf", model_data=data, resources=resources)
        self.assertEqual(response.status_code, 201)
        with patch("converter.tasks.publish"):
            convert_task.run(response.data["id"])
        task = ConversionTask.objects.get(pk=response.data["id"])
        self.assertTrue(Path(task.preview.path).read_bytes().startswith(b"glTF"))

    def test_reuse_requires_identical_maps_and_keeps_preview(self):
        from datetime import timedelta
        from django.utils import timezone
        response = self.upload(base_color=image_upload())
        original = ConversionTask.objects.get(pk=response.data["id"])
        original.artifact.save("existing.glb", ContentFile(b"artifact"), save=False)
        original.preview.save("existing-preview.glb", ContentFile(b"preview"), save=False)
        original.status, original.progress = "succeeded", 100
        original.artifact_expires_at = timezone.now() + timedelta(minutes=10)
        original.save()
        same = self.upload(base_color=image_upload())
        same_task = ConversionTask.objects.get(pk=same.data["id"])
        self.assertEqual(same_task.status, "succeeded")
        self.assertEqual(same_task.preview.name, original.preview.name)
        self.assertEqual(same_task.artifact.name, original.artifact.name)
        changed = self.upload(base_color=image_upload(color=(0, 0, 255)))
        changed_task = ConversionTask.objects.get(pk=changed.data["id"])
        self.assertEqual(changed_task.status, "queued")
        self.assertFalse(changed_task.artifact)

    def test_worker_is_dispatched_only_after_attachments_commit(self):
        with patch("converter.views.convert_task.apply_async") as dispatch:
            with self.captureOnCommitCallbacks(execute=True):
                response = self.client.post("/api/files/upload/", {
                    "file": SimpleUploadedFile("plane.obj", OBJ), "target_format": "glb",
                    "base_color": image_upload(),
                }, format="multipart")
                self.assertEqual(response.status_code, 201)
                self.assertEqual(ConversionTask.objects.get(pk=response.data["id"]).assets.count(), 1)
                dispatch.assert_not_called()
            dispatch.assert_called_once_with(args=[response.data["id"]], task_id=response.data["id"])

    def test_manual_base_color_replaces_a_missing_linked_texture(self):
        obj = OBJ.replace(b"o Plane", b"mtllib plane.mtl\no Plane\nusemtl Original")
        mtl = SimpleUploadedFile("plane.mtl", b"newmtl Original\nKd 1 1 1\nmap_Kd missing.png\n")
        response = self.upload(model_data=obj, resources=[mtl], base_color=image_upload("replacement.png"))
        with patch("converter.tasks.publish"):
            convert_task.run(response.data["id"])
        task = ConversionTask.objects.get(pk=response.data["id"])
        self.assertEqual(task.status, "succeeded")
