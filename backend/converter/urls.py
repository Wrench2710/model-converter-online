from django.urls import path
from rest_framework_simplejwt.views import TokenRefreshView
from .auth_views import CaptchaView, EmailLoginView, RegisterView
from .views import CurrentUserView, FormatCapabilitiesView, SourceFileListView, SourceUploadView, TaskArtifactView, TaskCancelView, TaskDetailView, TaskListView, TaskRetryView
from .views import TaskPreviewView, SourceFileDetailView

urlpatterns = [
    path("auth/register/", RegisterView.as_view()),
    path("auth/captcha/", CaptchaView.as_view()),
    path("auth/login/", EmailLoginView.as_view()),
    path("auth/refresh/", TokenRefreshView.as_view()),
    path("auth/me/", CurrentUserView.as_view()),
    path("formats/", FormatCapabilitiesView.as_view()),
    path("files/upload/", SourceUploadView.as_view()),
    path("files/", SourceFileListView.as_view()),
    path("files/<uuid:source_id>/", SourceFileDetailView.as_view()),
    path("tasks/", TaskListView.as_view()),
    path("tasks/<uuid:task_id>/", TaskDetailView.as_view()),
    path("tasks/<uuid:task_id>/artifact/", TaskArtifactView.as_view()),
    path("tasks/<uuid:task_id>/preview/", TaskPreviewView.as_view()),
    path("tasks/<uuid:task_id>/cancel/", TaskCancelView.as_view()),
    path("tasks/<uuid:task_id>/retry/", TaskRetryView.as_view()),
]
