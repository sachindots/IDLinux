"""Exercise the same worker used by the video window with a local, cookie-protected origin."""
import hashlib
import http.server
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest

from video import format_choices, publish, video_link, web_url


class VideoTest(unittest.TestCase):
    def test_format_choices(self):
        options = format_choices({'formats': [
            {'format_id': 'audio', 'url': 'https://a', 'vcodec': 'none', 'acodec': 'aac', 'ext': 'm4a'},
            {'format_id': 'hd', 'url': 'https://v', 'vcodec': 'h264', 'acodec': 'none', 'height': 1080, 'ext': 'mp4'},
            {'format_id': 'drm', 'url': 'https://d', 'has_drm': True}
        ]})
        self.assertEqual([item['id'] for item in options], ['bestvideo+bestaudio/best', 'hd+bestaudio/hd', 'audio'])
        self.assertIn('1080p', options[1]['label'])
        self.assertIn('Audio only', options[2]['label'])

    def test_inputs_and_existing_files(self):
        with self.assertRaises(ValueError):
            web_url('file:///etc/passwd')
        self.assertEqual(video_link('idlinux-video://open?url=https%3A%2F%2Fexample.com%2Fclip'), 'https://example.com/clip')
        for bad in ['idlinux-video://open?url=file:///etc/passwd', 'idlinux-video://open?url=https://a&url=https://b']:
            with self.assertRaises(ValueError):
                video_link(bad)
        with tempfile.TemporaryDirectory() as root:
            directory = Path(root)
            stage = directory / 'work'
            stage.mkdir()
            media = stage / 'sample.mp4'
            media.write_bytes(b'new')
            old = directory / media.name
            old.write_bytes(b'original')
            result = publish(media, directory)
            self.assertEqual(result.name, 'sample (1).mp4')
            self.assertEqual(result.read_bytes(), b'new')
            self.assertEqual(old.read_bytes(), b'original')

    def test_page_hls_dash(self):
        with tempfile.TemporaryDirectory() as root:
            base = Path(root)
            web = base / 'origin'
            web.mkdir()
            def ffmpeg(*args):
                subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', *args], check=True, cwd=web)
            ffmpeg('-f', 'lavfi', '-i', 'testsrc2=size=128x96:rate=8', '-t', '2',
                   '-c:v', 'libx264', '-g', '8', 'sample.mp4')
            ffmpeg('-i', 'sample.mp4', '-c', 'copy', '-hls_time', '1', 'sample.m3u8')
            ffmpeg('-i', 'sample.mp4', '-c', 'copy', '-f', 'dash', 'sample.mpd')
            (web / 'page.html').write_text('<title>Video fixture</title><video src="sample.mp4" controls></video>')
            class Origin(http.server.SimpleHTTPRequestHandler):
                def __init__(self, *args):
                    super().__init__(*args, directory=web)
                def do_GET(self):
                    if self.headers.get('Cookie') != 'session=fixture':
                        self.send_error(403)
                        return
                    super().do_GET()
                def log_message(self, *args):
                    pass
            server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Origin)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                for name in ['page.html', 'sample.m3u8', 'sample.mpd']:
                    with self.subTest(name=name):
                        stage = base / name
                        stage.mkdir()
                        cookie = dict(name='session', value='fixture', domain='127.0.0.1', hostOnly=True, secure=False, path='/')
                        offer = dict(url=f'http://127.0.0.1:{server.server_port}/{name}', browser=dict(cookies=[cookie]))
                        proc = subprocess.run([sys.executable, Path(__file__).with_name('video.py'), '--worker', stage],
                                              input=json.dumps(offer), text=True, capture_output=True, timeout=35)
                        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
                        result = Path(json.loads(proc.stdout.splitlines()[-1])['file'])
                        # Compare decoded video frames, including a playlist remuxed into a new container.
                        def frames(path):
                            data = subprocess.check_output(['ffmpeg', '-v', 'error', '-i', path, '-map', '0:v:0', '-f', 'rawvideo', '-'])
                            self.assertGreater(len(data), 0)
                            return hashlib.sha256(data).digest()
                        self.assertEqual(frames(result), frames(web / 'sample.mp4'))
            finally:
                server.shutdown()
                server.server_close()


if __name__ == '__main__':
    unittest.main()
