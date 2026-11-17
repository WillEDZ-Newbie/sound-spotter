import onnxruntime as ort, numpy as np, scipy.io.wavfile as w, scipy.signal as s, json, collections, soundfile as sf
S=ort.InferenceSession("/home/claude/vend/silero_vad/data/silero_vad_16k_op15.onnx")
def run(x):
    st=np.zeros((2,1,128),np.float32); ctx=np.zeros(64,np.float32); out=[]
    for i in range(0,len(x)-512,512):
        o,st=S.run(None,{"input":np.concatenate([ctx,x[i:i+512]])[None,:].astype(np.float32),"state":st,"sr":np.array(16000,np.int64)}); out.append(float(o.ravel()[0])); ctx=x[i+448:i+512]
    return np.array(out)
def prep(x,sr):
    x=s.resample_poly(x,16000,sr); x=s.sosfilt(s.butter(2,150,btype="high",fs=16000,output="sos"),x)
    # running level like the page: 3 s time constant, gain capped at 40 dB
    p=s.lfilter([0.00002],[1,-0.99998],x**2)+1e-9; g=np.minimum(100,0.05/np.sqrt(p)); g[:16000]=g[16000]
    return (x*g).astype(np.float32)
man=json.load(open("harness/manifest.json")); tab=collections.OrderedDict(); fa={}
for m in man:
    sr,x=w.read(f"harness/clips/{m['name']}.wav"); p=run(prep(x.astype(np.float64).mean(1)/2**31,sr)); fps=31.25
    import os; os.makedirs('harness/silero',exist_ok=True); json.dump([round(float(v),3) for v in p],open(f"harness/silero/{m['name']}.json",'w'))
    if m["kind"]=="bed": fa[m["name"]]=round(float((p[int(4*fps):]>0.5).sum()/fps),1); continue
    v=p[int(m["t0"]*fps):int(m["t1"]*fps)]; pre=p[int(4*fps):int(m["t0"]*fps)]
    k=m["kind"]+" "+m["name"].rsplit("_",1)[1]; t=tab.setdefault(k,[0,0]); t[1]+=1; t[0]+= (v>0.5).sum()/fps>=1.0
for k,(a,n) in tab.items(): print(k.ljust(14),f"{a}/{n}")
print("beds, seconds of voice:",{k.replace('bed_','').replace('msnsd_',''):v for k,v in fa.items() if v>0})
for f in ("../f/st.wav","../e/rec.wav","../c/rec.wav","../b/rec.wav"):
    sr,x=w.read(f); x=x.astype(np.float64); x=x.mean(1) if x.ndim>1 else x; x/= (2**31 if abs(x).max()>40000 else 32768)
    p=run(prep(x,sr)); idx=np.where(p>0.5)[0]/31.25; print(f,"voice seconds",round(len(idx)/31.25,1),"at",sorted(set(np.round(idx).astype(int)))[:20])
