from django.core.exceptions import ValidationError
from django.contrib.auth.password_validation import CommonPasswordValidator


class CommonPasswordVariantsValidator(CommonPasswordValidator):
    def validate(self, password, user=None):
        super().validate(password, user)
        # Check common words disguised with a numeric suffix or character substitutions.
        base = password.casefold().rstrip("0123456789!@#$%^&*()_+-=.,?")
        normalized = base.translate(str.maketrans({"@": "a", "0": "o", "1": "i", "3": "e", "$": "s", "5": "s"}))
        if normalized and normalized != password:
            super().validate(normalized, user)


class CharacterVarietyValidator:
    def validate(self, password, user=None):
        kinds = (
            any(char.islower() for char in password),
            any(char.isupper() for char in password),
            any(char.isdigit() for char in password),
            any(not char.isalnum() and not char.isspace() for char in password),
        )
        if sum(kinds) < 3:
            raise ValidationError(self.get_help_text(), code="password_variety")

    def get_help_text(self):
        return "Use at least three of uppercase letters, lowercase letters, numbers, and symbols."
