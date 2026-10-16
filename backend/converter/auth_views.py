import base64
import io
import secrets
import uuid

from django.conf import settings
from django.contrib.auth import get_user_model
from django.contrib.auth.password_validation import validate_password
from django.core.exceptions import ValidationError as DjangoValidationError
from django.db import IntegrityError, transaction
from django.utils.crypto import constant_time_compare, salted_hmac
from PIL import Image, ImageDraw, ImageFont
from redis import Redis
from redis.exceptions import RedisError
from rest_framework import serializers, status
from rest_framework.exceptions import ErrorDetail
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.throttling import AnonRateThrottle
from rest_framework.views import APIView
from rest_framework_simplejwt.serializers import TokenObtainPairSerializer
from rest_framework_simplejwt.tokens import RefreshToken
from rest_framework_simplejwt.views import TokenObtainPairView

CAPTCHA_TTL = 300
CAPTCHA_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"


def captcha_store():
    return Redis.from_url(settings.REDIS_URL, socket_connect_timeout=3, socket_timeout=3)


def captcha_digest(answer):
    return salted_hmac("modeldesk-registration-captcha", answer.upper()).hexdigest()


def captcha_image(answer):
    image = Image.new("RGB", (200, 64), "#1c1c1e")
    draw = ImageDraw.Draw(image)
    font = ImageFont.load_default(size=32)
    for index, char in enumerate(answer):
        glyph = Image.new("RGBA", (38, 54))
        ImageDraw.Draw(glyph).text((7, 6), char, font=font, fill="#f2f2f7")
        glyph = glyph.rotate(secrets.randbelow(25) - 12, resample=Image.Resampling.BICUBIC)
        image.paste(glyph, (index * 30 + 3, secrets.randbelow(5) + 3), glyph)
    for _ in range(5):
        draw.line([(secrets.randbelow(200), secrets.randbelow(64)),
                   (secrets.randbelow(200), secrets.randbelow(64))], fill="#76767c", width=1)
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")


class CaptchaThrottle(AnonRateThrottle):
    scope = "auth_captcha"


class RegistrationThrottle(AnonRateThrottle):
    scope = "auth_register"


class LoginThrottle(AnonRateThrottle):
    scope = "auth_login"


class CaptchaView(APIView):
    authentication_classes = ()
    permission_classes = (AllowAny,)
    throttle_classes = (CaptchaThrottle,)

    def get(self, request):
        answer = "".join(secrets.choice(CAPTCHA_ALPHABET) for _ in range(6))
        challenge_id = str(uuid.uuid4())
        try:
            captcha_store().setex(f"modeldesk:captcha:{challenge_id}", CAPTCHA_TTL, captcha_digest(answer))
        except RedisError:
            return Response({"detail": "Verification is temporarily unavailable.", "code": "service_unavailable"},
                            status=status.HTTP_503_SERVICE_UNAVAILABLE)
        response = Response({"id": challenge_id, "image": captcha_image(answer), "expires_in": CAPTCHA_TTL})
        response["Cache-Control"] = "no-store"
        return response


class RegistrationSerializer(serializers.Serializer):
    username = serializers.EmailField(max_length=150)
    password = serializers.CharField(write_only=True, trim_whitespace=False, max_length=256)
    captcha_id = serializers.UUIDField(write_only=True)
    captcha = serializers.CharField(write_only=True, max_length=6)

    def validate(self, attrs):
        # GETDEL consumes the challenge atomically, including incorrect attempts.
        expected = captcha_store().getdel(f"modeldesk:captcha:{attrs['captcha_id']}")
        if not expected or not constant_time_compare(expected.decode("ascii"), captcha_digest(attrs["captcha"])):
            raise serializers.ValidationError({
                "captcha": [ErrorDetail("Verification code is incorrect or expired. Refresh and try again.",
                                        code="captcha_invalid")],
            })
        username = attrs["username"].strip().lower()
        User = get_user_model()
        candidate = User(username=username, email=username)
        errors = {}
        try:
            validate_password(attrs["password"], user=candidate)
        except DjangoValidationError as exc:
            errors["password"] = [
                ErrorDetail(error.message % error.params if error.params else error.message, code=error.code)
                for error in exc.error_list
            ]
        if User.objects.filter(username__iexact=username).exists():
            errors["username"] = [ErrorDetail("An account with this email already exists.", code="unique")]
        if errors:
            raise serializers.ValidationError(errors)
        attrs["username"] = username
        return attrs


class RegisterView(APIView):
    authentication_classes = ()
    permission_classes = (AllowAny,)
    throttle_classes = (RegistrationThrottle,)

    def post(self, request):
        serializer = RegistrationSerializer(data=request.data)
        try:
            serializer.is_valid(raise_exception=True)
        except serializers.ValidationError as exc:
            return Response({"errors": exc.get_full_details()}, status=status.HTTP_400_BAD_REQUEST)
        except RedisError:
            return Response({"detail": "Verification is temporarily unavailable.", "code": "service_unavailable"},
                            status=status.HTTP_503_SERVICE_UNAVAILABLE)
        data = serializer.validated_data
        try:
            with transaction.atomic():
                user = get_user_model().objects.create_user(
                    username=data["username"], email=data["username"], password=data["password"],
                )
        except IntegrityError:
            return Response({"errors": {"username": [{
                "message": "An account with this email already exists.", "code": "unique",
            }]}}, status=status.HTTP_400_BAD_REQUEST)
        refresh = RefreshToken.for_user(user)
        return Response({
            "access": str(refresh.access_token), "refresh": str(refresh),
            "user": {"id": user.pk, "username": user.username},
        }, status=status.HTTP_201_CREATED)


class EmailTokenSerializer(TokenObtainPairSerializer):
    username = serializers.EmailField(max_length=150)

    def validate(self, attrs):
        attrs["username"] = attrs["username"].strip().lower()
        return super().validate(attrs)


class EmailLoginView(TokenObtainPairView):
    authentication_classes = ()
    serializer_class = EmailTokenSerializer
    throttle_classes = (LoginThrottle,)
