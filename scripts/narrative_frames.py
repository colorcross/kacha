"""Deterministic narrative cards. No browser, network, fallback fonts or shell."""
import json
import math
import subprocess
import sys
from PIL import Image, ImageDraw, ImageFont
from fontTools.ttLib import TTFont


def layout(m):
    s = m['spec']
    font_path = m['font']['path']
    font = TTFont(font_path, fontNumber=0)
    cmap = font.getBestCmap()
    strings = [s['title'], s['evidence'], '0123456789'] + [v for i in s['items'] for v in i.values()]
    missing = sorted({c for c in ''.join(strings) if not c.isspace() and ord(c) not in cmap})
    font.close()
    if missing:
        raise ValueError('字体缺字，不能替换：' + ''.join(missing))
    w, h = s['width'], s['height']
    portrait = h > w
    margin = 48
    gap = 20
    n = len(s['items'])
    columns = n if not portrait and s['recipe'] in ('comparison', 'steps') else (2 if not portrait and n>2 else 1)
    cell_w = (w-2*margin-gap*(columns-1))//columns
    cell_h = (h-260-gap*(math.ceil(n/columns)-1))//math.ceil(n/columns)
    boxes = [(margin+(i % columns)*(cell_w+gap), 155+(i//columns)*(cell_h+gap), cell_w, cell_h) for i in range(n)]
    label_size, body_size = (40,32) if portrait else ((36,30) if columns<=2 else (28,24))
    fonts = {k: ImageFont.truetype(font_path, size) for k, size in [('title',44), ('label',label_size), ('body',body_size), ('source',18)]}
    draw = ImageDraw.Draw(Image.new('RGB',(w,h)))

    def wrap(value, f, width, max_lines):
        lines = ['']
        for c in value:
            if draw.textlength(lines[-1]+c, font=f) > width:
                lines.append(c)
            else:
                lines[-1] += c
        if len(lines)>max_lines:
            raise ValueError('文字超出版面，请精简或减少节点：'+value)
        return lines
    title = wrap(s['title'], fonts['title'],w-96,2)
    source = wrap(s['evidence'], fonts['source'],w-96,2)
    content = []
    for item, (_,_,bw,bh) in zip(s['items'],boxes):
        label = wrap(item['label'],fonts['label'],bw-40,2)
        detail = wrap(item['detail'],fonts['body'],bw-40,max(0,(bh-80-len(label)*(label_size+8))//(body_size+8)))
        content.append((label,detail))
    return s, boxes, fonts, title, source, content


def render(m, variant, output, ffmpeg):
    s, boxes, fonts, title, source, content = layout(m)
    w,h,fps = s['width'],s['height'],s['fps']
    frames = round(fps*s['durationSeconds'])
    dark = s['pack']=='dahui-ai'
    bg, ink, muted, card, accent = ('#101820','#f1f5f9','#b8c5d0','#1c2a36','#66d3f0') if dark else ('#f5f2ea','#192630','#535f66','#ffffff','#185b7b')
    command = [ffmpeg,'-v','error','-nostdin','-n','-f','rawvideo','-pix_fmt','rgb24','-s',f'{w}x{h}','-r',str(fps),'-i','pipe:0','-an','-c:v','libx264','-threads','2','-crf','19','-pix_fmt','yuv420p','-movflags','+faststart',output]
    proc = subprocess.Popen(command,stdin=subprocess.PIPE,stderr=subprocess.PIPE)
    try:
        for frame in range(frames):
            t=frame/fps
            image=Image.new('RGB',(w,h),bg)
            draw=ImageDraw.Draw(image)
            for j,line in enumerate(title): draw.text((48,40+j*48),line,font=fonts['title'],fill=ink)
            for j,line in enumerate(source): draw.text((48,h-66+j*24),line,font=fonts['source'],fill=muted)
            for i,((x,y,bw,bh),(labels,details)) in enumerate(zip(boxes,content)):
                # All text settles in the first 1.3 seconds; the guided variant
                # then moves a single focus without hiding comparison evidence.
                entry=max(0,min(1,(t-(i*.16 if variant=='guided' else 0))/.55))
                yy=y+round(18*(1-entry)**3)
                focus = variant=='overview' or min(len(boxes)-1,int(max(0,t-1)/(max(1,s['durationSeconds']-2)/len(boxes))))==i
                layer=Image.new('RGB',(w,h),bg); d=ImageDraw.Draw(layer)
                d.rounded_rectangle((x,yy,x+bw,yy+bh),radius=10,fill=card,outline=accent if focus else muted,width=3 if focus else 1)
                if s['recipe'] in ('steps','timeline'):
                    d.text((x+20,yy+16),f'{i+1:02}',font=fonts['source'],fill=accent)
                else:
                    d.rectangle((x+20,yy+20,x+44,yy+24),fill=accent)
                label_height, body_height = fonts['label'].size+8, fonts['body'].size+8
                block_height=len(labels)*label_height+8+len(details)*body_height
                cy=yy+max(56,(bh-block_height)//2)
                for line in labels: d.text((x+20,cy),line,font=fonts['label'],fill=ink); cy+=label_height
                cy+=8
                for line in details: d.text((x+20,cy),line,font=fonts['body'],fill=muted); cy+=body_height
                # Mask only this card so other entries remain visible.
                crop=layer.crop((x,yy,x+bw+1,yy+bh+1)); base=image.crop((x,yy,x+bw+1,yy+bh+1))
                image.paste(Image.blend(base,crop,entry),(x,yy))
            proc.stdin.write(image.tobytes())
        proc.stdin.close()
        err=proc.stderr.read().decode(errors='replace')
        if proc.wait()!=0: raise RuntimeError(err)
    finally:
        if proc.poll() is None: proc.kill(); proc.wait()
        proc.stderr.close()


if __name__=='__main__':
    try:
        manifest=json.loads(sys.argv[2])
        if sys.argv[1]=='check': layout(manifest)
        elif sys.argv[1]=='render': render(manifest,*sys.argv[3:6])
        else: raise ValueError('unknown action')
    except Exception as error:
        print(str(error),file=sys.stderr)
        sys.exit(1)
