# Trains the voice-presence score (logistic regression on the detector's own features) and writes model.json.
import json, numpy as np, sys
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import GroupKFold
rows=[json.loads(l) for l in open("harness/features.jsonl")]
rows=[r for r in rows if r["y"]>=0 and not (r["clip"]=="real_laptop10" and 78<r["t"]<95)]
keys=[k for k in rows[0]["fv"].keys() if k!="logHi"]; X=np.array([[r["fv"][k] for k in keys] for r in rows]); y=np.array([r["y"] for r in rows])
grp=np.array([r["voice"] or r["clip"] for r in rows]); kind=np.array([r["kind"] for r in rows]); snr=np.array([r["snr"] if r["snr"] is not None else 99 for r in rows])
mu,sd=X.mean(0),X.std(0)+1e-9; Z=(X-mu)/sd
print("rows",len(y),"positives",int(y.sum()),"features",keys)
P=np.zeros(len(y))
for tr,te in GroupKFold(n_splits=6).split(Z,y,grp):
    m=LogisticRegression(C=0.5,class_weight={0:1,1:1.5},max_iter=2000).fit(Z[tr],y[tr]); P[te]=m.predict_proba(Z[te])[:,1]
neg=P[y==0]
for name,far in (("low",0.001),("normal",0.004),("high",0.012)):
    thr=float(np.quantile(neg,1-far)); line=[f"{name}: thr {thr:.2f}, negatives above {100*(neg>=thr).mean():.2f}%"]
    for kd in ("wall800","wall500","wall350","clear"):
        for sn in (5,0):
            sel=(kind==kd)&(snr==sn)&(y==1); line.append(f"{kd}{sn:+d} {100*(P[sel]>=thr).mean():.0f}%")
    print(" | ".join(line))
m=LogisticRegression(C=0.5,class_weight={0:1,1:1.5},max_iter=2000).fit(Z,y)
thr=[round(float(np.quantile(neg,1-f)),3) for f in (0.001,0.004,0.012)]
print("weights:",{k:round(float(w),2) for k,w in zip(keys,m.coef_[0])})
model={"version":"2026-11-17a","trained_on":f"{len(y)} rows: 12 voices through 800/500/350 Hz walls and clear at +5/0 dB in real room noise, 12 noise beds, 5 real recordings","HI_MUFFLED":0.06,
 "logit":{"voicePresent":{"w":{k:round(float(w),4) for k,w in zip(keys,m.coef_[0])},"b":round(float(m.intercept_[0]),4),"mean":{k:round(float(v),5) for k,v in zip(keys,mu)},"sd":{k:round(float(v),5) for k,v in zip(keys,sd)},"thr":thr}}}
json.dump(model,open("model.json","w"),indent=1); print("wrote model.json thr",thr)
