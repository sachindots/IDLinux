#!/usr/bin/python3
"""Video download window and its cancellable yt-dlp worker."""
import ctypes
import errno
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
from urllib.parse import parse_qs, urlsplit


sys.path.insert(0, str(Path(__file__).parent / 'vendor'))

def web_url(value):
    if not isinstance(value, str) or len(value) > 16384 or any(ord(c) < 32 for c in value):
        raise ValueError("Enter an HTTP or HTTPS video link.")
    parsed = urlsplit(value)
    if parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.username is not None:
        raise ValueError("Enter an HTTP or HTTPS video link without embedded credentials.")
    return value


def video_link(value):
    link = urlsplit(value)
    if link.scheme != 'idlinux-video' or link.netloc != 'open' or link.path not in ('', '/'):
        raise ValueError("Invalid video handoff.")
    urls = parse_qs(link.query).get('url', [])
    if len(urls) != 1:
        raise ValueError("A handoff needs one video link.")
    return web_url(urls[0])


def publish(file, directory):
    # renameat2 publishes atomically on Linux, including filesystems without hard links.
    rename = ctypes.CDLL(None, use_errno=True).renameat2
    for number in range(10000):
        name = file.name if number == 0 else f'{file.stem} ({number}){file.suffix}'
        target = directory / name
        if rename(-100, os.fsencode(file), -100, os.fsencode(target), 1) == 0:
            return target
        code = ctypes.get_errno()
        if code != errno.EEXIST:
            raise OSError(code, os.strerror(code))
    raise ValueError("Choose a destination with fewer matching filenames.")


def download(offer, stage, report, probe=False):
    from http.cookiejar import Cookie, DefaultCookiePolicy
    from time import monotonic
    from yt_dlp import YoutubeDL

    previous = 0.0
    def progress(item):
        nonlocal previous
        now = monotonic()
        if item['status'] != 'downloading' or now - previous < 0.25:
            return
        previous = now
        size = item.get('total_bytes') or item.get('total_bytes_estimate')
        done = item.get('downloaded_bytes') or 0
        report(f'{100 * done / size:.0f}% · {done / 1048576:.1f} MiB' if size else f'{done / 1048576:.1f} MiB')

    def reject_live(info, *, incomplete=False):
        if info.get('is_live') or info.get('has_drm') is True:
            raise ValueError("Choose a recorded video without DRM.")

    url = web_url(offer['url'])
    browser = offer.get('browser') or {}
    headers = {}
    if browser.get('referer'):
        headers['Referer'] = web_url(browser['referer'])
    if browser.get('userAgent'):
        headers['User-Agent'] = browser['userAgent']
    finished = []
    options = {
        'outtmpl': str(stage / '%(title).100B [%(id).40B].%(ext)s'),
        'logtostderr': True, 'quiet': True, 'no_warnings': True, 'noprogress': True, 'cachedir': False,
        'noplaylist': True, 'playlistend': 1, 'socket_timeout': 20,
        'http_headers': headers, 'progress_hooks': [progress], 'post_hooks': [finished.append],
        'match_filter': reject_live,
        'format': offer.get('format') or 'bestvideo+bestaudio/best',
        'js_runtimes': {'node': {'path': shutil.which('node') or '/usr/bin/node'}},

    }
    with YoutubeDL(options) as ydl:
        ydl.cookiejar.set_policy(DefaultCookiePolicy(strict_ns_domain=DefaultCookiePolicy.DomainStrictNonDomain))
        for c in browser.get('cookies', []):
            domain = c['domain'].lstrip('.')
            host_only = c['hostOnly']
            if not host_only:
                domain = '.' + domain
            ydl.cookiejar.set_cookie(Cookie(0, c['name'], c['value'], None, False, domain,
                                            not host_only, not host_only, c['path'], True, c['secure'],
                                            None, True, None, None, {}, False))
        info = ydl.extract_info(url, download=not probe)
        if probe:
            return format_choices(info)

    if len(finished) != 1:
        raise ValueError("No single downloadable video was found at this link.")
    result = Path(finished[0])
    if result.parent != stage or result.is_symlink() or not result.is_file():
        raise ValueError("The extractor returned an unexpected output file.")
    return result


def format_choices(info):
    choices = [{'id': 'bestvideo+bestaudio/best', 'label': 'Best available video + audio'}]
    for item in reversed(info.get('formats') or []):
        if item.get('has_drm') or not item.get('url') or item.get('vcodec') == 'none' and item.get('acodec') == 'none':
            continue
        fid = str(item['format_id'])
        video = item.get('vcodec') != 'none'
        silent = video and item.get('acodec') == 'none'
        selector = fid + '+bestaudio/' + fid if silent else fid
        resolution = item.get('resolution') or (str(item['height']) + 'p' if item.get('height') else 'Audio')
        size = item.get('filesize') or item.get('filesize_approx')
        label = ' · '.join(str(part) for part in [
            resolution if video else 'Audio only', item.get('ext'),
            str(item['fps']) + ' fps' if video and item.get('fps') else None,
            str(round(size / 1048576, 1)) + ' MiB' if size else None,
            'video + audio' if silent else None, 'ID ' + fid
        ] if part)
        choices.append({'id': selector, 'label': label})
    return choices


def window(offer):
    import gi
    gi.require_version('Gtk', '3.0')
    gi.require_version('Gdk', '3.0')
    from gi.repository import Gdk, GLib, Gtk
    from threading import Thread

    if offer.get('url'):
        web_url(offer['url'])
    bundled = Path(__file__).parent / 'extensions/chrome/fonts/IBMPlexSans.ttf'
    font = bundled if bundled.is_file() else Path(__file__).resolve().parents[1] / 'src/renderer/src/assets/fonts/IBMPlexSans.ttf'
    if font.is_file():
        ctypes.CDLL('libfontconfig.so.1').FcConfigAppFontAddFile(None, os.fsencode(font))
    Gtk.Settings.get_default().set_property("gtk-application-prefer-dark-theme", True)
    style = Gtk.CssProvider()
    style.load_from_data(b'''
        #idlinux-video { background: #19191c; color: #eeeeef; font-family: "IBM Plex Sans", Sans; font-size: 15px; }
        #video-title { font-size: 25px; font-weight: 600; color: #eeeeef; }
        #idlinux-video entry, #idlinux-video button { border-radius: 5px; min-height: 30px; }
        #idlinux-video checkbutton { color: #eeeeef; }
        #idlinux-video .suggested-action { background: #7974ca; color: #ffffff; border-color: #7974ca; }
    ''')
    Gtk.StyleContext.add_provider_for_screen(Gdk.Screen.get_default(), style, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)
    win = Gtk.Window(title="ID Linux · Download video", default_width=510, border_width=22)
    box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=12)
    win.set_name("idlinux-video")
    win.add(box)
    title = Gtk.Label(label="Save video", xalign=0)
    title.set_name("video-title")
    box.add(title)
    box.add(Gtk.Label(label="Video page or stream URL", xalign=0))
    entry = Gtk.Entry(text=offer.get('url', ''), placeholder_text="https://", hexpand=True)
    box.add(entry)
    dest = Path(GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DOWNLOAD) or Path.home() / 'Downloads')
    dest.mkdir(parents=True, exist_ok=True)
    chooser = Gtk.FileChooserButton(title="Save video to", action=Gtk.FileChooserAction.SELECT_FOLDER)
    chooser.set_filename(str(dest))
    box.add(chooser)
    session = Gtk.CheckButton(label="Use my browser session for this video")
    box.add(session)
    formats = Gtk.ComboBoxText()
    formats.append('bestvideo+bestaudio/best', 'Best available video + audio')
    formats.set_active(0)
    box.add(Gtk.Label(label="Quality and format", xalign=0))
    box.add(formats)
    inspect = Gtk.Button(label="Find available qualities")
    box.add(inspect)
    status = Gtk.Label(label="Ready", xalign=0, wrap=True, selectable=True)
    box.add(status)
    button = Gtk.Button(label="Download video")
    button.get_style_context().add_class('suggested-action')
    box.add(button)
    child = None
    cancelled = False
    closing = False

    def finish(message):
        nonlocal child
        child = None
        if closing:
            Gtk.main_quit()
            return False
        for widget in (entry, chooser, session, formats, inspect):
            widget.set_sensitive(True)
        button.set_label("Download video")
        button.set_sensitive(True)
        status.set_text(message)
        return False

    def monitor(process, staging, folder, payload):
        try:
            process.stdin.write(json.dumps(payload) + '\n')
            process.stdin.close()
            result = None
            message = 'Video download failed.'
            for line in process.stdout:
                event = json.loads(line)
                if 'formats' in event:
                    def show_formats(items=event['formats']):
                        formats.remove_all()
                        for item in items:
                            formats.append(item['id'], item['label'])
                        formats.set_active(0)
                    GLib.idle_add(show_formats)
                    message = 'Choose a quality, then download.'
                if 'progress' in event:
                    GLib.idle_add(status.set_text, event['progress'])
                if 'error' in event:
                    message = event['error']
                if 'file' in event:
                    result = Path(event['file'])
            if process.wait() == 0 and result and not cancelled:
                if result.parent != Path(staging.name) or result.is_symlink():
                    raise ValueError("Unexpected output path.")
                message = f'Saved to {publish(result, folder)}'
        except (ValueError, OSError) as exc:
            message = str(exc)
        finally:
            if staging:
                staging.cleanup()
        GLib.idle_add(finish, 'Cancelled' if cancelled else message)

    def stop():
        nonlocal cancelled
        cancelled = True
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        button.set_sensitive(False)

    def click(_widget=None, *_):
        probing = _widget is inspect
        nonlocal child, cancelled
        if child:
            stop()
            return
        try:
            url = web_url(entry.get_text().strip())
            folder = Path(chooser.get_filename() or dest)
            staging = None if probing else tempfile.TemporaryDirectory(prefix='.idlinux-video-', dir=folder)
            try:
                child = subprocess.Popen([sys.executable, __file__, '--probe' if probing else '--worker', '-' if probing else staging.name],
                                         stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                         stderr=subprocess.DEVNULL, text=True, start_new_session=True)
            except OSError:
                if staging:
                    staging.cleanup()
                raise
        except (ValueError, OSError) as exc:
            status.set_text(str(exc))
            return
        payload = {'url': url, 'format': formats.get_active_id()}
        if url == offer.get('url') and offer.get('browser'):
            ctx = dict(offer['browser'])
            if not session.get_active():
                ctx.pop('cookies', None)
            payload['browser'] = ctx
        cancelled = False
        for widget in (entry, chooser, session, formats, inspect):
            widget.set_sensitive(False)
        status.set_text("Finding video…")
        button.set_label("Cancel download")
        Thread(target=monitor, args=(child, staging, folder, payload), daemon=True).start()

    def close(*_):
        nonlocal closing
        if child:
            closing = True
            stop()
            return True
        Gtk.main_quit()
        return False

    inspect.connect('clicked', click)
    button.connect('clicked', click)
    entry.connect('activate', click)
    win.connect('delete-event', close)
    win.show_all()
    session.set_visible(bool((offer.get('browser') or {}).get('cookies')))
    entry.connect('changed', lambda *_: session.set_visible(
        entry.get_text().strip() == offer.get('url') and bool((offer.get('browser') or {}).get('cookies'))))
    if '--offer' in sys.argv:
        print('ready', flush=True)
        sys.stdout.close()
    Gtk.main()


if __name__ == '__main__':
    os.umask(0o077)
    if len(sys.argv) == 3 and sys.argv[1] in ('--worker', '--probe'):
        try:
            result = download(json.load(sys.stdin), Path(sys.argv[2]),
                              lambda text: print(json.dumps({'progress': text}), flush=True), probe=sys.argv[1] == '--probe')
            print(json.dumps({'formats': result} if sys.argv[1] == '--probe' else {'file': str(result)}))
        except Exception as exc:
            print(json.dumps({'error': str(exc)}))
            sys.exit(1)
    elif len(sys.argv) == 3 and sys.argv[1] == '--link':
        window({'url': video_link(sys.argv[2])})
    else:
        window(json.load(sys.stdin) if '--offer' in sys.argv else {})
