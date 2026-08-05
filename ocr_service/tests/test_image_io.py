from __future__ import annotations

import base64
import io
import unittest

from ocr_service.image_io import ImageInputError, ImageTooLarge, UnsupportedMediaType, decode_image

try:
    from PIL import Image
except ImportError:  # pragma: no cover - the lightweight host test env may omit Pillow.
    Image = None  # type: ignore[assignment]


def encoded_image(format_name: str = "JPEG", size: tuple[int, int] = (96, 72), exif_orientation: int | None = None) -> str:
    if Image is None:
        raise unittest.SkipTest("Pillow is not installed")
    image = Image.new("RGB", size, "white")
    output = io.BytesIO()
    kwargs = {}
    if exif_orientation is not None:
        exif = image.getexif()
        exif[274] = exif_orientation
        kwargs["exif"] = exif.tobytes()
    image.save(output, format=format_name, **kwargs)
    return base64.b64encode(output.getvalue()).decode("ascii")


@unittest.skipIf(Image is None, "Pillow is not installed")
class ImageInputTests(unittest.TestCase):
    def test_exif_orientation_is_applied(self) -> None:
        decoded = decode_image(encoded_image(exif_orientation=6), "image/jpeg")
        self.assertEqual((decoded.width, decoded.height), (72, 96))
        self.assertEqual(decoded.image.mode, "RGB")

    def test_magic_mime_and_base64_are_checked(self) -> None:
        data = encoded_image()
        with self.assertRaises(UnsupportedMediaType):
            decode_image(data, "image/png")
        with self.assertRaises(ImageInputError):
            decode_image("not-base64!!!", "image/jpeg")

    def test_dimension_limit_is_checked_before_decode(self) -> None:
        with self.assertRaises(ImageTooLarge):
            decode_image(encoded_image(size=(9000, 64)), "image/jpeg")


if __name__ == "__main__":
    unittest.main()
