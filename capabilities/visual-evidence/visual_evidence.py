"""Bounded local visual evidence adapter. Never generates art or invokes a model.
Use prepare/compare -> native workspace read of the returned PNG -> acknowledge.
MCP capability wrappers may stringify image blocks; this two-stage protocol avoids
that failure without modifying the gateway, disabling safety, or opening a port.
"""
from __future__ import annotations
import hashlib, io, json, os, re, sys, time, uuid, warnings
from pathlib import Path
from PIL import Image, ImageOps, ImageDraw
CONFIG = Path(__file__).with_name('roots.json')
FOLDER = '.visual-evidence'
SUPPORTED = {'PNG', 'JPEG', 'WEBP', 'GIF'}

class EvidenceError(ValueError):
    pass

def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()

def load_config() -> dict:
    return json.loads(CONFIG.read_text(encoding='utf-8'))

def root_for(project: str, config: dict) -> Path:
    if project not in config['roots']:
        raise EvidenceError('PROJECT_NOT_ALLOWLISTED')
    root = Path(config['roots'][project]).resolve(strict=True)
    if not root.is_dir(): raise EvidenceError('PROJECT_NOT_DIRECTORY')
    return root

def confined(root: Path, relative: str, exists: bool = True) -> Path:
    if not isinstance(relative, str) or not relative or '\x00' in relative:
        raise EvidenceError('INVALID_RELATIVE_PATH')
    # Reject absolute paths, ADS, URL schemes and traversal on every platform.
    normal = relative.replace('\\', '/')
    if normal.startswith('/') or ':' in normal or '..' in normal.split('/'):
        raise EvidenceError('PATH_OUTSIDE_PROJECT')
    target = (root / normal).resolve(strict=exists)
    if not target.is_relative_to(root) or target == root:
        raise EvidenceError('PATH_OUTSIDE_PROJECT')
    return target

def stable_image(root: Path, relative: str, config: dict, expected_sha: str | None = None):
    path = confined(root, relative)
    if not path.is_file(): raise EvidenceError('NOT_A_REGULAR_FILE')
    if path.suffix.lower() not in ('.png', '.jpg', '.jpeg', '.webp', '.gif'):
        raise EvidenceError('UNSUPPORTED_IMAGE_EXTENSION')
    raw = None
    for _ in range(3):
        before = path.stat()
        if before.st_size <= 0 or before.st_size > config['max_source_bytes']:
            raise EvidenceError('SOURCE_BYTE_LIMIT')
        with path.open('rb') as stream: data = stream.read(config['max_source_bytes'] + 1)
        after = path.stat()
        if len(data) <= config['max_source_bytes'] and (before.st_mtime_ns, before.st_size) == (after.st_mtime_ns, after.st_size) and len(data) == after.st_size:
            raw = data
            break
        time.sleep(.075)
    if raw is None: raise EvidenceError('SOURCE_STILL_CHANGING')
    sha = digest(raw)
    if expected_sha and expected_sha.lower() != sha: raise EvidenceError('SOURCE_HASH_MISMATCH')
    with warnings.catch_warnings():
        warnings.simplefilter('error', Image.DecompressionBombWarning)
        try:
            with Image.open(io.BytesIO(raw)) as probe:
                if probe.format not in SUPPORTED: raise EvidenceError('UNSUPPORTED_SIGNATURE')
                if probe.width * probe.height > config['max_source_pixels']: raise EvidenceError('SOURCE_PIXEL_LIMIT')
                if getattr(probe, 'n_frames', 1) != 1: raise EvidenceError('ANIMATED_IMAGE_REQUIRES_EXPLICIT_FRAME_EXTRACTION')
                source_size = list(probe.size); source_format = probe.format; probe.verify()
            with Image.open(io.BytesIO(raw)) as opened:
                image = ImageOps.exif_transpose(opened).convert('RGBA')
                image.load()
        except EvidenceError: raise
        except Exception as exc: raise EvidenceError('IMAGE_DECODE_FAILED: ' + type(exc).__name__) from exc
    return image, {'source_path': str(path.relative_to(root)), 'source_sha256': sha, 'source_bytes': len(raw), 'source_size': source_size, 'source_format': source_format, 'source_mtime_ns': after.st_mtime_ns, 'display_size': list(image.size)}

def preview_bytes(image: Image.Image, edge: int, config: dict):
    if not isinstance(edge, int) or not 256 <= edge <= 2048: raise EvidenceError('MAX_EDGE_OUT_OF_RANGE')
    # Some host-native readers discard alpha and reveal hidden RGB. Composite
    # transparent input over a declared neutral matte before transmitting pixels.
    work = Image.new('RGBA', image.size, (244, 243, 246, 255))
    work.alpha_composite(image.convert('RGBA'))
    work = work.convert('RGB')
    work.thumbnail((edge, edge), Image.Resampling.LANCZOS)
    while True:
        buf = io.BytesIO(); work.save(buf, format='PNG', compress_level=7)
        data = buf.getvalue()
        if len(data) <= config['max_preview_bytes']:
            return data, list(work.size)
        if max(work.size) < 320: raise EvidenceError('PREVIEW_BYTE_LIMIT')
        work = work.resize((max(1, round(work.width*.78)), max(1, round(work.height*.78))), Image.Resampling.LANCZOS)

def store(root: Path, image: Image.Image, record: dict, edge: int, config: dict) -> dict:
    data, size = preview_bytes(image, edge, config)
    folder = confined(root, FOLDER, exists=False)
    folder.mkdir(exist_ok=True)
    identity = 've_' + uuid.uuid4().hex
    png = folder / (identity + '.png'); receipt = folder / (identity + '.json')
    record = {**record, 'id': identity, 'status': 'PREPARED_NOT_VISUALLY_REVIEWED', 'created_unix': time.time(), 'preview_path': str(png.relative_to(root)), 'preview_size': size, 'preview_bytes': len(data), 'preview_sha256': digest(data), 'mime_type': 'image/png', 'preview_alpha_policy': 'opaque composite over RGB 244,243,246; original unchanged', 'read_transport': 'DevSpace native read(workspaceId, preview_path); must receive actual image content', 'aesthetic_verdict': 'NOT_ASSIGNED', 'source_mutated': False}
    # Never overwrite a prior receipt. Publish the complete PNG before its receipt.
    with png.open('xb') as stream: stream.write(data)
    with receipt.open('x', encoding='utf-8') as stream: json.dump(record, stream, ensure_ascii=True, indent=2)
    return record

def read_receipt(root: Path, identity: str):
    if not isinstance(identity, str) or not re.fullmatch(r've_[a-f0-9]{32}', identity): raise EvidenceError('INVALID_RECEIPT_ID')
    return json.loads(confined(root, f'{FOLDER}/{identity}.json').read_text(encoding='utf-8'))

def verify_receipt(root: Path, receipt: dict, config: dict):
    path = confined(root, receipt['preview_path'])
    if digest(path.read_bytes()) != receipt['preview_sha256']: raise EvidenceError('PREVIEW_CHANGED')
    for src in receipt['sources']:
        stable_image(root, src['source_path'], config, src['source_sha256'])
    return True

def prepare(args: dict, config: dict):
    root = root_for(args['project'], config)
    image, source = stable_image(root, args['path'], config, args.get('expected_sha256'))
    box = args.get('crop')
    if box is not None:
        if not isinstance(box, list) or len(box) != 4 or any(type(x) is not int for x in box): raise EvidenceError('INVALID_CROP')
        l,t,r,b = box
        if not (0 <= l < r <= image.width and 0 <= t < b <= image.height): raise EvidenceError('CROP_OUTSIDE_IMAGE')
        image = image.crop(box)
    return store(root, image, {'operation': 'prepare', 'sources': [source], 'crop': box, 'transform': 'EXIF orientation, explicit crop if supplied, uniform downscale only; no redraw, no warping'}, args.get('max_edge', 1280), config)

def compare(args: dict, config: dict):
    root = root_for(args['project'], config)
    mode = args.get('mode', 'side_by_side')
    if mode not in ('side_by_side', 'registered_overlay'): raise EvidenceError('INVALID_COMPARE_MODE')
    images=[];sources=[];labels=args.get('labels', ['REFERENCE', 'MODEL'])
    if not isinstance(labels,list) or len(labels)!=2 or any(not isinstance(x,str) or len(x)>80 for x in labels):raise EvidenceError('INVALID_LABELS')
    for key in ('reference', 'model'):
        image, src = stable_image(root, args[key], config, args.get(key+'_sha256')); images.append(image);sources.append(src)
    a,b = images
    if mode == 'registered_overlay':
        # Scaling/registration must already have been done by a documented camera contract.
        if a.size != b.size: raise EvidenceError('REGISTRATION_REQUIRED: identical pixel canvas required; never stretch one reference to fit')
        if not isinstance(args.get('registration_note'),str) or len(args['registration_note'])<16: raise EvidenceError('REGISTRATION_NOTE_REQUIRED')
        images.append(Image.blend(a,b,.55));labels=labels+['55% MODEL / REFERENCE']
    height = min(900,max(im.height for im in images));resized=[]
    for image in images:
        width=max(1,round(image.width*height/image.height));resized.append(image.resize((width,height),Image.Resampling.LANCZOS))
    canvas=Image.new('RGBA',(sum(im.width for im in resized)+12*(len(resized)-1),height+40),(244,243,246,255));draw=ImageDraw.Draw(canvas);x=0
    for image,label in zip(resized,labels):
        canvas.alpha_composite(image,(x,40));draw.text((x+8,10),label,fill=(30,30,40,255));x+=image.width+12
    return store(root,canvas,{'operation':mode,'sources':sources,'labels':labels,'registration_note':args.get('registration_note'),'transform':'uniform resize and labelled juxtaposition; no inferred similarity score','overlay_weight':.55 if mode=='registered_overlay' else None},args.get('max_edge',1600),config)

def acknowledge(args: dict, config: dict):
    root=root_for(args['project'],config);receipt=read_receipt(root,args['id']);verify_receipt(root,receipt,config)
    if args.get('observed_preview_sha256')!=receipt['preview_sha256']:raise EvidenceError('WRONG_PREVIEW_ACK')
    observations=args.get('observations','').strip();verdict=args.get('verdict')
    if verdict not in ('PASS','FAIL','INCONCLUSIVE'):raise EvidenceError('INVALID_VERDICT')
    if len(observations)<30:raise EvidenceError('EXPLICIT_VISUAL_OBSERVATIONS_REQUIRED')
    record={'receipt':receipt['id'],'preview_sha256':receipt['preview_sha256'],'source_sha256':[s['source_sha256'] for s in receipt['sources']],'verdict':verdict,'observations':observations,'attestation':'agent-reported visual review after native image read; NOT machine-inferred perception','recorded_unix':time.time()}
    target=confined(root,f'{FOLDER}/{receipt["id"]}-review-{uuid.uuid4().hex[:8]}.json',exists=False)
    with target.open('x',encoding='utf-8') as stream:json.dump(record,stream,ensure_ascii=True,indent=2)
    return {**record,'review_path':str(target.relative_to(root))}

def main():
    try:
        args=json.load(sys.stdin);action=sys.argv[1] if len(sys.argv)>1 else None
        if not isinstance(args,dict):raise EvidenceError('ARGUMENTS_MUST_BE_OBJECT')
        function={'prepare':prepare,'compare':compare,'acknowledge':acknowledge}.get(action)
        if function is None:raise EvidenceError('UNKNOWN_ACTION')
        result=function(args,load_config());print(json.dumps({'ok':True,**result},ensure_ascii=True))
    except Exception as exc:
        print(json.dumps({'ok':False,'error':type(exc).__name__,'message':str(exc),'visual_acceptance':'BLOCKED'},ensure_ascii=True));sys.exit(1)
if __name__=='__main__':main()
