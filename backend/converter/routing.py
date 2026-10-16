from django.urls import re_path
from .consumers import TaskConsumer

websocket_urlpatterns = [re_path(r"ws/tasks/(?P<task_id>[0-9a-f-]+)/$", TaskConsumer.as_asgi())]
