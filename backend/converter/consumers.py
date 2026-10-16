from channels.generic.websocket import AsyncJsonWebsocketConsumer
from channels.db import database_sync_to_async
from rest_framework_simplejwt.authentication import JWTAuthentication
from rest_framework_simplejwt.exceptions import InvalidToken, TokenError

class TaskConsumer(AsyncJsonWebsocketConsumer):
    async def connect(self):
        self.task_id = self.scope["url_route"]["kwargs"]["task_id"]
        token = self.scope["query_string"].decode().split("token=", 1)[-1].split("&", 1)[0] if b"token=" in self.scope["query_string"] else ""
        try:
            validated = JWTAuthentication().get_validated_token(token)
            self.user = await database_sync_to_async(JWTAuthentication().get_user)(validated)
        except (InvalidToken, TokenError, TypeError):
            await self.close(code=4401)
            return
        if not await self.owns_task():
            await self.close(code=4403)
            return
        self.group_name = f"task-{self.task_id}"
        await self.channel_layer.group_add(self.group_name, self.channel_name)
        await self.accept()
        await self.send_json(await self.snapshot())

    @database_sync_to_async
    def snapshot(self):
        from .models import ConversionTask
        task = ConversionTask.objects.get(pk=self.task_id, owner_id=self.user.pk)
        return {
            "id": str(task.id), "status": task.status, "progress": task.progress,
            "error_message": task.error_message,
        }

    @database_sync_to_async
    def owns_task(self):
        from .models import ConversionTask
        return ConversionTask.objects.filter(id=self.task_id, owner_id=self.user.pk).exists()

    async def disconnect(self, code):
        if hasattr(self, "group_name"):
            await self.channel_layer.group_discard(self.group_name, self.channel_name)

    async def task_progress(self, event):
        await self.send_json(event["payload"])
