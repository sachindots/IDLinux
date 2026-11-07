"""Fetch the pinned extractor wheels and verify their hashes before packaging."""
import hashlib
import io
from pathlib import Path
import urllib.request
import zipfile

WHEELS = [
    ('https://files.pythonhosted.org/packages/7f/3d/16ea7d5638cf585991f2c5705e8083688dde633d32d0871f2404e0f4d827/yt_dlp-2026.10.26-py3-none-any.whl', 'a05c5b5d8562f7e8a62f5334348b406af4930d56d3a65f8021d14af0e22339ae'),
    ('https://files.pythonhosted.org/packages/e3/bd/520769863744b669440a924271a6159ddd82ad5ae26b4ac4d4b69e9f8d44/yt_dlp_ejs-0.8.0-py3-none-any.whl', '79300e5fca7f937a1eeede11f0456862c1b41107ce1d726871e0207424f4bdb4'),
]
target = Path(__file__).parent / 'vendor'
target.mkdir(exist_ok=True)
for url, digest in WHEELS:
    with urllib.request.urlopen(url, timeout=45) as response:
        data = response.read()
    if hashlib.sha256(data).hexdigest() != digest:
        raise ValueError('Video dependency checksum mismatch')
    with zipfile.ZipFile(io.BytesIO(data)) as wheel:
        wheel.extractall(target)
print('Prepared yt-dlp 2026.10.26 and EJS 0.8.0')
