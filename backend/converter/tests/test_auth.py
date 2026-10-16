import base64
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.test import TestCase
from rest_framework.test import APIClient


class RegistrationTests(TestCase):
    def setUp(self):
        cache.clear()
        self.client = APIClient()
        self.challenge_ids = []

    def tearDown(self):
        if self.challenge_ids:
            from converter.auth_views import captcha_store
            captcha_store().delete(*(f"modeldesk:captcha:{key}" for key in self.challenge_ids))
        cache.clear()

    def challenge(self):
        with patch("secrets.choice", return_value="A"):
            response = self.client.get("/api/auth/captcha/")
        self.assertEqual(response.status_code, 200)
        self.challenge_ids.append(response.data["id"])
        return response.data

    def register(self, **overrides):
        challenge = self.challenge()
        data = {
            "username": "member@example.com",
            "password": "Solar!Bridge7846",
            "captcha_id": challenge["id"],
            "captcha": "AAAAAA",
        }
        data.update(overrides)
        return self.client.post("/api/auth/register/", data, format="json")

    def test_captcha_is_an_image_without_the_answer(self):
        challenge = self.challenge()
        self.assertEqual(set(challenge), {"id", "image", "expires_in"})
        self.assertEqual(challenge["expires_in"], 300)
        image = base64.b64decode(challenge["image"].split(",", 1)[1])
        self.assertTrue(image.startswith(b"\x89PNG\r\n\x1a\n"))

    def test_valid_registration_and_email_login(self):
        response = self.register(username=" Member@Example.COM ")
        self.assertEqual(response.status_code, 201)
        user = get_user_model().objects.get(username="member@example.com")
        self.assertEqual(user.email, user.username)
        self.assertTrue(user.check_password("Solar!Bridge7846"))
        self.assertNotIn("password", response.data["user"])
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {response.data['access']}")
        self.assertEqual(self.client.get("/api/auth/me/").data["id"], user.pk)
        self.client.credentials()
        login = self.client.post("/api/auth/login/", {
            "username": " MEMBER@EXAMPLE.COM ", "password": "Solar!Bridge7846",
        }, format="json")
        self.assertEqual(login.status_code, 200)

    def test_username_requires_an_email(self):
        response = self.register(username="ordinary-name")
        self.assertEqual(response.status_code, 400)
        self.assertIn("username", response.data["errors"])
        self.assertFalse(get_user_model().objects.filter(is_active=True).exists())

    def test_duplicate_email_has_a_specific_error(self):
        self.assertEqual(self.register().status_code, 201)
        response = self.register(username="MEMBER@EXAMPLE.COM")
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.data["errors"]["username"][0]["code"], "unique")

    def test_weak_passwords_are_rejected(self):
        for password in ("short", "1234567890123456", "password123!", "P@ssw0rd123!", "abcdefghijklmno",
                         "Member@Example.com"):
            with self.subTest(password_type=len(password)):
                response = self.register(password=password)
                self.assertEqual(response.status_code, 400)
                self.assertIn("password", response.data["errors"])
        self.assertFalse(get_user_model().objects.filter(is_active=True).exists())

    def test_captcha_is_required(self):
        response = self.client.post("/api/auth/register/", {
            "username": "member@example.com", "password": "Solar!Bridge7846",
        }, format="json")
        self.assertEqual(response.status_code, 400)
        self.assertIn("captcha", response.data["errors"])

    def test_wrong_captcha_cannot_be_retried_or_replayed(self):
        challenge = self.challenge()
        data = {"username": "member@example.com", "password": "Solar!Bridge7846",
                "captcha_id": challenge["id"], "captcha": "WRONG"}
        response = self.client.post("/api/auth/register/", data, format="json")
        self.assertEqual(response.status_code, 400)
        self.assertIn("captcha", response.data["errors"])
        data["captcha"] = "AAAAAA"
        response = self.client.post("/api/auth/register/", data, format="json")
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.data["errors"]["captcha"][0]["code"], "captcha_invalid")
        self.assertFalse(get_user_model().objects.filter(is_active=True).exists())

    def test_successful_captcha_cannot_be_replayed(self):
        challenge = self.challenge()
        data = {"username": "member@example.com", "password": "Solar!Bridge7846",
                "captcha_id": challenge["id"], "captcha": "aaaaaa"}
        self.assertEqual(self.client.post("/api/auth/register/", data, format="json").status_code, 201)
        data["username"] = "other@example.com"
        response = self.client.post("/api/auth/register/", data, format="json")
        self.assertEqual(response.status_code, 400)
        self.assertIn("captcha", response.data["errors"])

    def test_expired_captcha_is_rejected(self):
        from converter.auth_views import captcha_store
        challenge = self.challenge()
        captcha_store().expire(f"modeldesk:captcha:{challenge['id']}", 0)
        response = self.register(captcha_id=challenge["id"])
        self.assertEqual(response.status_code, 400)
        self.assertIn("captcha", response.data["errors"])

    def test_stale_token_does_not_block_public_auth(self):
        self.client.credentials(HTTP_AUTHORIZATION="Bearer expired-token")
        response = self.register()
        self.assertEqual(response.status_code, 201)
        login = self.client.post("/api/auth/login/", {
            "username": "member@example.com", "password": "Solar!Bridge7846",
        }, format="json")
        self.assertEqual(login.status_code, 200)

    def test_captcha_creation_is_throttled(self):
        for _ in range(30):
            self.challenge()
        self.assertEqual(self.client.get("/api/auth/captcha/").status_code, 429)
