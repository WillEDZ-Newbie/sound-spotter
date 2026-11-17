# Builds test clips the voicehunter way: known voices, through a wall model or clean, mixed into a real quiet-room recording at known SNR.
import numpy as np, scipy.io.wavfile as w, scipy.signal as s, soundfile as sf, glob, os, json, sys
VH="/home/claude/voicehunter/tests/fixtures"; OUT="harness/clips"; os.makedirs(OUT,exist_ok=True)
sr,bg=w.read("../f/st.wav"); bg=bg[205*sr:305*sr].astype(np.float64)/2**31      # 100 s of the real room, no swell in it
def load48(p):
    x,fs=sf.read(p); x=x.mean(1) if x.ndim>1 else x
    return s.resample_poly(x,48000,fs)
def wall(x,cut,order=4,loss_db=20.0):   # voicehunter tests/conftest.py through_wall (F-0591), at 48 kHz
    y=s.sosfiltfilt(s.butter(order,cut,btype="lowpass",fs=48000,output="sos"),x)
    b,a=s.iirpeak(180,Q=2,fs=48000); return (y+0.5*s.lfilter(b,a,y))*10**(-loss_db/20)
def bandp(x,lo,hi): 
    y=s.sosfilt(s.butter(4,[lo,hi],btype="band",fs=48000,output="sos"),x); return np.mean(y**2)
voices={os.path.basename(p).split(".")[0]:load48(p) for p in sorted(glob.glob(VH+"/*.wav")+glob.glob(VH+"/voices/*.flac"))}
beds={os.path.basename(p).split(".")[0]:load48(p) for p in sorted(glob.glob(VH+"/beds/*.flac")+[VH+"/traffic60.flac"])}
man=[]; rng=np.random.default_rng(1)
def put(name,sig,start,kind,expect):
    n=25*sr; o=rng.integers(0,len(bg)-n); x=bg[o:o+n].copy(); m=min(len(sig),n-start*sr)
    x[start*sr:start*sr+m,0]+=sig[:m]; x[start*sr:start*sr+m,1]+=np.roll(sig,5)[:m]
    w.write(f"{OUT}/{name}.wav",sr,(np.clip(x,-1,1)*2**31).astype(np.int32)); man.append({"name":name,"t0":start,"t1":start+m/sr,"kind":kind,"expect":expect})
bgp=bandp(bg[:30*sr].mean(1),100,800); bgw=bandp(bg[:30*sr].mean(1),150,3400)
for vn,v in voices.items():
    v=np.tile(v,int(np.ceil(15*sr/len(v))))[:15*sr]
    for cond,cut in (("wall800",800),("wall500",500),("wall350",350),("clear",None)):
        y=wall(v,cut,loss_db=0) if cut else v
        lo,hi,ref=(100,800,bgp) if cut else (150,3400,bgw)
        yb=s.sosfilt(s.butter(4,[lo,hi],btype="band",fs=48000,output="sos"),y); act=yb**2>0.02*np.percentile(yb**2,99.5); vp=np.mean(yb[act]**2)
        for snr in (5,0,-5):
            put(f"{vn}_{cond}_{snr:+d}",y*np.sqrt(ref/vp*10**(snr/10)),8,cond,"speech" if cut else "voice")
for bn,b in beds.items():
    b=b[:15*sr]; 
    for snr in (0,10):   # a bed as loud as the room's own noise in the speech band, and 10 dB louder
        put(f"bed_{bn}_{snr:+d}",b*np.sqrt(bgw/bandp(b,150,3400)*10**(snr/10)),8,"bed","none")
put("room_only",np.zeros(sr),8,"bed","none")
json.dump(man,open("harness/manifest.json","w"),indent=1); print(len(man),"clips;",len(voices),"voices;",len(beds),"beds")
