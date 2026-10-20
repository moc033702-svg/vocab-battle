# 生成答题反馈音效（可选工具，不参与运行）。
# 用法：python tools/gen-audio.py
# 产物：public/audio/correct.wav、public/audio/wrong.wav（单声道 44.1kHz 16bit）
# 想换音色就改下面的参数重新跑；想换真实音效，直接覆盖两个 wav 即可，代码不用动。
import math
import os
import struct
import wave

SR = 44100


def tone(freq, dur, amp=1.0, decay=7.0, glide=1.0, harm=((1, 1.0),)):
    """单个音：正弦叠加谐波，指数衰减包络，可选滑音（glide 为结束/起始频率比）。"""
    n = int(SR * dur)
    out = [0.0] * n
    phase = 0.0
    for i in range(n):
        t = i / SR
        f = freq * (glide ** (t / dur))
        phase += 2 * math.pi * f / SR
        s = 0.0
        for k, w in harm:
            s += w * math.sin(phase * k)
        # 5ms 起音避免爆音
        env = (t / 0.005) if t < 0.005 else math.exp(-(t - 0.005) * decay)
        out[i] = amp * env * s
    return out


def mix(track, clip, at):
    start = int(at * SR)
    need = start + len(clip)
    if len(track) < need:
        track.extend([0.0] * (need - len(track)))
    for i, v in enumerate(clip):
        track[start + i] += v


def normalize(track, peak=0.62, fade=0.02):
    top = max(abs(v) for v in track) or 1.0
    k = peak / top
    track = [v * k for v in track]
    n = int(fade * SR)
    for i in range(min(n, len(track))):
        track[-1 - i] *= i / n
    return track


def write_wav(path, track):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with wave.open(path, 'w') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        frames = b''.join(struct.pack('<h', int(max(-1.0, min(1.0, v)) * 32767)) for v in track)
        w.writeframes(frames)
    print(f'{path}  {len(frames) / 1024:.1f} KB  {len(track) / SR:.2f}s')


# 答对：C5–E5–G5 上行三连音，末尾一颗高音闪亮
ok = []
mix(ok, tone(523.25, 0.34, 0.9, decay=9), 0.00)
mix(ok, tone(659.25, 0.34, 0.85, decay=9), 0.085)
mix(ok, tone(783.99, 0.40, 0.80, decay=8), 0.170)
mix(ok, tone(1046.50, 0.26, 0.34, decay=11, harm=((1, 1.0), (2, 0.15))), 0.250)
write_wav('public/audio/correct.wav', normalize(ok))

# 答错：A3 → F3 下行两音，带轻微下沉滑音，柔和但明确
bad = []
mix(bad, tone(220.00, 0.30, 0.95, decay=6.5, glide=0.92, harm=((1, 1.0), (2, 0.28), (3, 0.10))), 0.00)
mix(bad, tone(174.61, 0.34, 0.90, decay=5.5, glide=0.94, harm=((1, 1.0), (2, 0.24), (3, 0.08))), 0.14)
write_wav('public/audio/wrong.wav', normalize(bad))

# 催促：两声明亮的门铃（E6 → A6），比答题音更「提神」但不刺耳
bell = []
mix(bell, tone(1318.51, 0.45, 0.85, decay=13, harm=((1, 1.0), (2, 0.22), (3, 0.08))), 0.00)
mix(bell, tone(1760.00, 0.60, 0.80, decay=11, harm=((1, 1.0), (2, 0.20), (3, 0.06))), 0.155)
write_wav('public/audio/nudge.wav', normalize(bell, peak=0.55))
