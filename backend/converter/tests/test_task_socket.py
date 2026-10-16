from asgiref.sync import async_to_sync
from channels.testing import WebsocketCommunicator
from django.contrib.auth import get_user_model
from django.test import TransactionTestCase, override_settings
from rest_framework_simplejwt.tokens import RefreshToken

from config.asgi import application
from converter.models import ConversionTask, SourceFile


@override_settings(CHANNEL_LAYERS={"default": {"BACKEND": "channels.layers.InMemoryChannelLayer"}})
class TaskSocketTests(TransactionTestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user(username="socket@example.com")
        source = SourceFile.objects.create(
            owner=self.user, original_name="model.obj", extension="obj",
            size_bytes=1, sha256="a" * 64, file="sources/test.obj",
        )
        self.task = ConversionTask.objects.create(
            owner=self.user, source_file=source, target_format="glb",
            status="succeeded", progress=100,
        )

    def test_connection_receives_completion_that_happened_before_subscribing(self):
        token = str(RefreshToken.for_user(self.user).access_token)

        async def check():
            socket = WebsocketCommunicator(application, f"/ws/tasks/{self.task.id}/?token={token}")
            connected, _ = await socket.connect()
            self.assertTrue(connected)
            snapshot = await socket.receive_json_from()
            self.assertEqual(snapshot["status"], "succeeded")
            self.assertEqual(snapshot["progress"], 100)
            await socket.disconnect()

        async_to_sync(check)()

    def test_rejected_connection_can_disconnect_without_a_group(self):
        async def check():
            socket = WebsocketCommunicator(application, f"/ws/tasks/{self.task.id}/?token=invalid")
            connected, code = await socket.connect()
            self.assertFalse(connected)
            self.assertEqual(code, 4401)
            await socket.disconnect()

        async_to_sync(check)()
