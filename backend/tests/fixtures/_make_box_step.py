"""Emit a valid AP214 STEP file for an axis-aligned box (test fixture)."""
import sys, itertools

L=[]; 
def e(s):
    L.append(s); return len(L)  # 1-based entity id

W,H,D = 2.0, 1.0, 3.0
corners = [(x,y,z) for x in (0,W) for y in (0,H) for z in (0,D)]
def idx(x,y,z): return corners.index((x,y,z))

pt  = [e(f"CARTESIAN_POINT('',({x:.6f},{y:.6f},{z:.6f}));") for (x,y,z) in corners]
vtx = [e(f"VERTEX_POINT('',#{p});") for p in pt]

# 12 edges as (i,j) corner indices
edges_def = []
for a,b in itertools.combinations(range(8),2):
    ca,cb = corners[a], corners[b]
    if sum(1 for k in range(3) if ca[k]!=cb[k]) == 1:
        edges_def.append((a,b))

edge_ids = {}
for a,b in edges_def:
    ca,cb = corners[a], corners[b]
    d = [cb[k]-ca[k] for k in range(3)]
    n = max(abs(v) for v in d); d = [v/n for v in d]
    p0 = e(f"CARTESIAN_POINT('',({ca[0]:.6f},{ca[1]:.6f},{ca[2]:.6f}));")
    dr = e(f"DIRECTION('',({d[0]:.6f},{d[1]:.6f},{d[2]:.6f}));")
    vc = e(f"VECTOR('',#{dr},1.0);")
    ln = e(f"LINE('',#{p0},#{vc});")
    edge_ids[(a,b)] = e(f"EDGE_CURVE('',#{vtx[a]},#{vtx[b]},#{ln},.T.);")

# 6 faces: (axis, value, normal_sign)
faces_spec = [(0,0.0,-1),(0,W,1),(1,0.0,-1),(1,H,1),(2,0.0,-1),(2,D,1)]
face_ids=[]
for axis,val,sign in faces_spec:
    ring = [c for c in corners if c[axis]==val]
    o1,o2 = [k for k in range(3) if k!=axis]
    # order the 4 corners into a cycle
    def key(c): return (c[o1],c[o2])
    lo1,hi1 = sorted({c[o1] for c in ring}); lo2,hi2 = sorted({c[o2] for c in ring})
    order = [(lo1,lo2),(hi1,lo2),(hi1,hi2),(lo1,hi2)]
    if sign < 0: order.reverse()
    cyc = [next(c for c in ring if key(c)==k) for k in order]
    oes=[]
    for i in range(4):
        a,b = idx(*cyc[i]), idx(*cyc[(i+1)%4])
        if (a,b) in edge_ids: ec,ori = edge_ids[(a,b)], ".T."
        else:                 ec,ori = edge_ids[(b,a)], ".F."
        oes.append(e(f"ORIENTED_EDGE('',*,*,#{ec},{ori});"))
    loop = e("EDGE_LOOP('',(" + ",".join(f"#{o}" for o in oes) + "));")
    bnd  = e(f"FACE_OUTER_BOUND('',#{loop},.T.);")
    org  = [0.0,0.0,0.0]; org[axis]=val
    nrm  = [0.0,0.0,0.0]; nrm[axis]=float(sign)
    ref  = [0.0,0.0,0.0]; ref[o1]=1.0
    op = e(f"CARTESIAN_POINT('',({org[0]:.6f},{org[1]:.6f},{org[2]:.6f}));")
    dn = e(f"DIRECTION('',({nrm[0]:.6f},{nrm[1]:.6f},{nrm[2]:.6f}));")
    dr = e(f"DIRECTION('',({ref[0]:.6f},{ref[1]:.6f},{ref[2]:.6f}));")
    ax = e(f"AXIS2_PLACEMENT_3D('',#{op},#{dn},#{dr});")
    pl = e(f"PLANE('',#{ax});")
    face_ids.append(e(f"ADVANCED_FACE('',(#{bnd}),#{pl},.T.);"))

shell = e("CLOSED_SHELL('',(" + ",".join(f"#{f}" for f in face_ids) + "));")
brep  = e(f"MANIFOLD_SOLID_BREP('Box',#{shell});")

o=e("CARTESIAN_POINT('',(0.,0.,0.));"); z=e("DIRECTION('',(0.,0.,1.));"); x=e("DIRECTION('',(1.,0.,0.));")
ax0=e(f"AXIS2_PLACEMENT_3D('',#{o},#{z},#{x});")
lu=e("( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.) );")
au=e("( NAMED_UNIT(*) PLANE_ANGLE_UNIT() SI_UNIT($,.RADIAN.) );")
su=e("( NAMED_UNIT(*) SI_UNIT($,.STERADIAN.) SOLID_ANGLE_UNIT() );")
unc=e(f"UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-07),#{lu},'','');")
ctx=e(f"( GEOMETRIC_REPRESENTATION_CONTEXT(3) GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((#{unc})) GLOBAL_UNIT_ASSIGNED_CONTEXT((#{lu},#{au},#{su})) REPRESENTATION_CONTEXT('','3D') );")
asr=e(f"ADVANCED_BREP_SHAPE_REPRESENTATION('',(#{ax0},#{brep}),#{ctx});")
pd_ctx=e("APPLICATION_CONTEXT('automotive design');")
e(f"APPLICATION_PROTOCOL_DEFINITION('','automotive_design',2000,#{pd_ctx});")
pctx=e("PRODUCT_CONTEXT('',#%d,'mechanical');" % pd_ctx)
prod=e("PRODUCT('Box','Box','',(#%d));" % pctx)
pdf=e(f"PRODUCT_DEFINITION_FORMATION('','',#{prod});")
pdc=e(f"PRODUCT_DEFINITION_CONTEXT('part definition',#{pd_ctx},'design');")
pd=e(f"PRODUCT_DEFINITION('','',#{pdf},#{pdc});")
pds=e(f"PRODUCT_DEFINITION_SHAPE('','',#{pd});")
e(f"SHAPE_DEFINITION_REPRESENTATION(#{pds},#{asr});")

body = "\n".join(f"#{i+1}={s}" for i,s in enumerate(L))
out = f"""ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('Box test fixture'),'2;1');
FILE_NAME('box.step','2026-09-05T00:00:00',(''),(''),'gen','gen','');
FILE_SCHEMA(('AUTOMOTIVE_DESIGN {{ 1 0 10303 214 1 1 1 1 }}'));
ENDSEC;
DATA;
{body}
ENDSEC;
END-ISO-10303-21;
"""
open(sys.argv[1],"w").write(out)
print("wrote", sys.argv[1], len(out), "bytes,", len(L), "entities")
