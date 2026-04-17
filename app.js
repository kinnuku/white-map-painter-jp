
/* =====================================================
   アンドゥ・リドゥ基盤
   各操作は pushHistory(説明, undoFn, redoFn) で登録。
   undo/redo は差分だけを持つクロージャ方式。
   ===================================================== */

const HISTORY_MAX = 200;
let undoStack = [];
let redoStack = [];

function pushHistory(desc, undoFn, redoFn){
    undoStack.push({ desc, undo: undoFn, redo: redoFn });
    if(undoStack.length > HISTORY_MAX) undoStack.shift();
    redoStack = [];
    updateUndoStatus();
}

function doUndo(){
    if(undoStack.length === 0) return;
    const entry = undoStack.pop();
    entry.undo();
    redoStack.push(entry);
    updateUndoStatus();
}

function doRedo(){
    if(redoStack.length === 0) return;
    const entry = redoStack.pop();
    entry.redo();
    undoStack.push(entry);
    updateUndoStatus();
}

function updateUndoStatus(){
    const el = document.getElementById('undoStatus');
    const u = undoStack.length > 0 ? undoStack[undoStack.length-1].desc : null;
    const r = redoStack.length > 0 ? redoStack[redoStack.length-1].desc : null;
    el.textContent = (u ? `↩ ${u}` : '') + (u && r ? '　' : '') + (r ? `↪ ${r}` : '');
}

document.addEventListener('keydown', e => {
    const ctrl = e.ctrlKey || e.metaKey;
    if(ctrl && !e.shiftKey && e.key === 'z'){ e.preventDefault(); doUndo(); }
    if(ctrl && (e.key === 'y' || (e.shiftKey && e.key === 'z'))){ e.preventDefault(); doRedo(); }
});

/* =====================================================
   地図初期化
   ===================================================== */

const map = L.map('map',{
    zoomControl:true,
    attributionControl:false,
    zoomSnap:0.1,
    zoomDelta:0.2,
    wheelPxPerZoomLevel:200,
    preferCanvas:true
}).setView([37.5,137],5);

map.createPane("polygonPane");
map.createPane("circlePane");
map.createPane("starPane");
map.createPane("labelPane");

map.getPane("polygonPane").style.zIndex = 300;
map.getPane("circlePane").style.zIndex = 450;
map.getPane("starPane").style.zIndex = 500;
map.getPane("labelPane").style.zIndex = 550;

let layerGroup  = L.layerGroup().addTo(map);
let labelLayer  = L.layerGroup().addTo(map);
let starLayer   = L.layerGroup().addTo(map);
let circleLayer = L.layerGroup().addTo(map);

let currentColor = "#e60000";

let colorData      = JSON.parse(localStorage.getItem("colors")       || "{}");
let sizeData       = JSON.parse(localStorage.getItem("sizes")        || "{}");
let starData       = JSON.parse(localStorage.getItem("stars")        || "[]");
let labelPos       = JSON.parse(localStorage.getItem("labels")       || "{}");
let labelVisible   = JSON.parse(localStorage.getItem("labelVisible") ?? "true");
let labelColorData = JSON.parse(localStorage.getItem("labelColors")  || "{}");

let geoCache     = {};
let renderedKeys = new Set();
let used         = new Set();
let starMode     = false;
let circleMode   = false;

/* Leafletオブジェクト参照 */
let labelMarkers   = {};          /* key -> L.marker */
let starMarkers    = new Map();   /* starObj -> L.marker */
let leafletCircles = new Map();   /* circleObj -> L.circle */
let polygonLayer = L.layerGroup().addTo(map);

/* =====================================================
   保存ユーティリティ
   ===================================================== */
const saveColors       = () => localStorage.setItem("colors",       JSON.stringify(colorData));
const saveSizes        = () => localStorage.setItem("sizes",        JSON.stringify(sizeData));
const saveStars        = () => localStorage.setItem("stars",        JSON.stringify(starData));
const saveLabels       = () => localStorage.setItem("labels",       JSON.stringify(labelPos));
const saveLabelColors  = () => localStorage.setItem("labelColors",  JSON.stringify(labelColorData));
const saveLabelVisible = () => localStorage.setItem("labelVisible", JSON.stringify(labelVisible));

/* =====================================================
   色選択
   ===================================================== */
function setColor(c){
    currentColor = c;
    document.querySelectorAll('.color-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.color-picker-wrap').forEach(p => p.classList.remove('active'));
    const btn = document.querySelector(`[data-color="${c}"]`);
    if(btn) btn.classList.add('active');
}
function pickColor(color){
    currentColor = color;
    document.querySelectorAll('.color-btn').forEach(b => b.classList.remove('active'));
    document.querySelector('.color-picker-wrap').classList.add('active');
}

/* =====================================================
   都道府県 UI
   ===================================================== */
const PREF_ORDER = ["北海道","青森県","岩手県","宮城県","秋田県","山形県","福島県",
"茨城県","栃木県","群馬県","埼玉県","千葉県","東京都","神奈川県",
"新潟県","富山県","石川県","福井県","山梨県","長野県",
"岐阜県","静岡県","愛知県","三重県",
"滋賀県","京都府","大阪府","兵庫県","奈良県","和歌山県",
"鳥取県","島根県","岡山県","広島県","山口県",
"徳島県","香川県","愛媛県","高知県",
"福岡県","佐賀県","長崎県","熊本県","大分県","宮崎県","鹿児島県","沖縄県"];

function createPrefUI(data){
    const set = new Set(data.features.map(f => f.properties.N03_001));
    const container = document.getElementById("prefList");
    PREF_ORDER.forEach(pref => {
        if(!set.has(pref)) return;
        const label = document.createElement("label");
        const input = document.createElement("input");
        input.type = "checkbox"; input.value = pref; input.onchange = render;
        label.appendChild(input);
        label.appendChild(document.createTextNode(pref));
        container.appendChild(label);
    });
}
function getSelected(){
    return [...document.querySelectorAll("#prefList input:checked")].map(i => i.value);
}
function selectAll(flag){
    document.querySelectorAll("#prefList input").forEach(i => i.checked = flag);
    render();
}
function getName(f){ return f.properties.N03_005 || f.properties.N03_004; }

/* =====================================================
   描画
   ===================================================== */
async function render(){
    polygonLayer.clearLayers();
    labelLayer.clearLayers();
    labelMarkers = {};
    used.clear();
    renderedKeys.clear();

    const selected = getSelected();
    if(selected.length === 0) return;

    for(const pref of selected){
        try{
            let data = geoCache[pref];
            if(!data){
                const res = await fetch(`geo/${pref}.geojson`);
                if(!res.ok) throw new Error(pref + " 読み込み失敗");
                data = await res.json();
                geoCache[pref] = data;
            }

            L.geoJSON(data, {
                pane: "polygonPane",
                style: f => ({
                    color:"#000", weight:1,
                    fillColor: colorData[f.properties.N03_007] || "#fff",
                    fillOpacity:1
                }),
                onEachFeature: (f, layer) => {
                    const key      = f.properties.N03_007;
                    const name     = getName(f);
                    const safeName = escapeHtml(name || "");
                    if(!name) return;
                    renderedKeys.add(key);

                    /* 色塗り */
                    layer.on('click', () => {
                        if (starMode) return;
                        const prev = colorData[key] || null;
                        const next = currentColor;
                        if(prev === next) return;
                        colorData[key] = next; saveColors();
                        layer.setStyle({ fillColor: next });
                        pushHistory(`色塗り`,
                            () => { if(prev===null) delete colorData[key]; else colorData[key]=prev; saveColors(); layer.setStyle({fillColor:prev||"#fff"}); },
                            () => { colorData[key]=next; saveColors(); layer.setStyle({fillColor:next}); }
                        );
                    });
                    layer.on('contextmenu', e => {
                        e.originalEvent.preventDefault();
                        const prev = colorData[key] || null;
                        if(!prev) return;
                        delete colorData[key]; saveColors();
                        layer.setStyle({ fillColor: "#fff" });
                        pushHistory(`色削除`,
                            () => { colorData[key]=prev; saveColors(); layer.setStyle({fillColor:prev}); },
                            () => { delete colorData[key]; saveColors(); layer.setStyle({fillColor:"#fff"}); }
                        );
                    });

                    /* ラベル */
                    if(labelVisible && !used.has(key)){
                        used.add(key);
                        const center = labelPos[key] || layer.getBounds().getCenter();
                        addLabelMarker(key, safeName, center);
                    }
                }
            }).addTo(polygonLayer);

        } catch(err){ console.error(err); }
    }
    polygonLayer.bringToBack();
    circleLayer.bringToFront();
    starLayer.bringToFront();
    labelLayer.bringToFront();
}

/* =====================================================
   ラベルマーカー生成
   ===================================================== */
function makeLabelIcon(key, safeName){
    return L.divIcon({
        className:'label',
        html:`<div class="label-inner"
            style="font-size:${sizeData[key]||12}px;color:${labelColorData[key]||'#000'}">
            ${safeName}
        </div>`
    });
}

function addLabelMarker(key, safeName, center){
    const marker = L.marker(center, { pane: "labelPane", draggable:true, icon: makeLabelIcon(key, safeName) }).addTo(labelLayer);
    labelMarkers[key] = marker;

    /* 右クリック削除 */
    marker.on('contextmenu', e => {
        e.originalEvent.preventDefault();
        labelLayer.removeLayer(marker);
        delete labelMarkers[key];
        const pos = marker.getLatLng();
        pushHistory(`ラベル削除`,
            () => { addLabelMarker(key, safeName, pos); },
            () => { if(labelMarkers[key]){ labelLayer.removeLayer(labelMarkers[key]); delete labelMarkers[key]; } }
        );
    });

    /* 左クリック */
    marker.on('click', e => {
        /* Shift → 白黒反転 */
        if(e.originalEvent.shiftKey){
            const prev = labelColorData[key] || "#000";
            const next = prev === "#fff" ? "#000" : "#fff";
            labelColorData[key] = next; saveLabelColors();
            marker.setIcon(makeLabelIcon(key, safeName));
            pushHistory(`ラベル色変更`,
                () => { labelColorData[key]=prev; saveLabelColors(); if(labelMarkers[key]) labelMarkers[key].setIcon(makeLabelIcon(key,safeName)); },
                () => { labelColorData[key]=next; saveLabelColors(); if(labelMarkers[key]) labelMarkers[key].setIcon(makeLabelIcon(key,safeName)); }
            );
            return;
        }
        /* サイズ変更 */
        const input = prompt("ラベルサイズ(px)", sizeData[key] || 12);
        const next = parseFontSize(input);
        if(next === null){ if(input !== null) alert("1〜300 の数字で入力してください。"); return; }
        const prev = sizeData[key] || 12;
        sizeData[key] = next; saveSizes();
        marker.setIcon(makeLabelIcon(key, safeName));
        pushHistory(`ラベルサイズ変更`,
            () => { sizeData[key]=prev; saveSizes(); if(labelMarkers[key]) labelMarkers[key].setIcon(makeLabelIcon(key,safeName)); },
            () => { sizeData[key]=next; saveSizes(); if(labelMarkers[key]) labelMarkers[key].setIcon(makeLabelIcon(key,safeName)); }
        );
    });

    /* ドラッグ */
    let dragFrom = null;
    marker.on('dragstart', () => { dragFrom = marker.getLatLng(); });
    marker.on('dragend', e => {
        const to   = e.target.getLatLng();
        const from = dragFrom;
        labelPos[key] = { lat:to.lat, lng:to.lng }; saveLabels();
        pushHistory(`ラベル移動`,
            () => { labelPos[key]={lat:from.lat,lng:from.lng}; saveLabels(); if(labelMarkers[key]) labelMarkers[key].setLatLng(from); },
            () => { labelPos[key]={lat:to.lat,lng:to.lng};     saveLabels(); if(labelMarkers[key]) labelMarkers[key].setLatLng(to);   }
        );
    });

    return marker;
}

/* =====================================================
   星
   ===================================================== */

function toggleStarMode() {
    starMode = !starMode;

    document.getElementById("starBtn").classList.toggle("active", starMode);

    // もし排他にしたいなら
    if (starMode) {
        circleMode = false;
        document.getElementById("circleBtn").classList.remove("active");
    }
}

/* =====================================================
   円
   ===================================================== */

function toggleCircleMode() {
    circleMode = !circleMode;

    document.getElementById("circleBtn").classList.toggle("active", circleMode);

    // 排他
    if (circleMode) {
        starMode = false;
        document.getElementById("starBtn").classList.remove("active");
    }
}

function makeStarIcon(s){
    return L.divIcon({
        className:'star-icon',
        html:`<div style="font-size:${s.size}px;color:${s.color};text-shadow:1px 1px 2px #000;">★</div>`,
        iconAnchor:null
    });
}

map.on('click', e => {
    if(!starMode) return;
    const input = prompt("星サイズ(px)", 20);
    const sz = parseFontSize(input);
    if(sz === null){ if(input !== null) alert("1〜300 の数字で入力してください。"); return; }

    const s = { lat:e.latlng.lat, lng:e.latlng.lng, size:sz, color:"#ffd700", circles:[] };
    starData.push(s); saveStars();
    addStar(s);

    pushHistory(`★追加`,
        () => {
            const i = starData.indexOf(s); if(i!==-1) starData.splice(i,1); saveStars();
            if(starMarkers.has(s)){ starLayer.removeLayer(starMarkers.get(s)); starMarkers.delete(s); }
            (s.circles||[]).forEach(c => { if(leafletCircles.has(c)){ circleLayer.removeLayer(leafletCircles.get(c)); leafletCircles.delete(c); } });
        },
        () => { starData.push(s); saveStars(); addStar(s); (s.circles||[]).forEach(c => addCircle(s,c)); }
    );
});

function addStar(s){
    if(!s.circles) s.circles = [];
    const marker = L.marker([s.lat, s.lng], { pane: "starPane", draggable:true, icon:makeStarIcon(s) }).addTo(starLayer);
    starMarkers.set(s, marker);

    /* ドラッグ */
    let dragFrom = null;
    marker.on('dragstart', () => { dragFrom = marker.getLatLng(); });
    marker.on('dragend', e => {
        const to = e.target.getLatLng(), from = dragFrom;
        s.lat = to.lat; s.lng = to.lng; saveStars();
        pushHistory(`★移動`,
            () => { s.lat=from.lat; s.lng=from.lng; saveStars(); if(starMarkers.has(s)) starMarkers.get(s).setLatLng(from); },
            () => { s.lat=to.lat;   s.lng=to.lng;   saveStars(); if(starMarkers.has(s)) starMarkers.get(s).setLatLng(to);   }
        );
    });

    /* クリック */
    marker.on('click', e => {

        /* 円モード */
        if(circleMode){
            const km = prompt("この星を中心に半径（km）", 10);
            if(km === null) return;
            const r = Number(km);
            if(!Number.isFinite(r) || r <= 0){ alert("正しい数値を入力してください"); return; }
            const c = { lat:s.lat, lng:s.lng, radiusKm:r, color:currentColor };
            s.circles.push(c); saveStars(); addCircle(s,c);
            pushHistory(`円追加`,
                () => { const i=s.circles.indexOf(c); if(i!==-1) s.circles.splice(i,1); saveStars(); if(leafletCircles.has(c)){ circleLayer.removeLayer(leafletCircles.get(c)); leafletCircles.delete(c); } },
                () => { s.circles.push(c); saveStars(); addCircle(s,c); }
            );
            return;
        }

        /* Shift → 色変更 */
        if(e.originalEvent.shiftKey){
            const prev = s.color, next = currentColor;
            s.color = next; saveStars();
            marker.setIcon(makeStarIcon(s));
            pushHistory(`★色変更`,
                () => { s.color=prev; saveStars(); if(starMarkers.has(s)) starMarkers.get(s).setIcon(makeStarIcon(s)); },
                () => { s.color=next; saveStars(); if(starMarkers.has(s)) starMarkers.get(s).setIcon(makeStarIcon(s)); }
            );
            return;
        }

        /* サイズ変更 */
        const input = prompt("サイズ(px)", s.size);
        const next = parseFontSize(input);
        if(next === null){ if(input !== null) alert("1〜300 の数字で入力してください。"); return; }
        const prev = s.size;
        s.size = next; saveStars();
        marker.setIcon(makeStarIcon(s));
        pushHistory(`★サイズ変更`,
            () => { s.size=prev; saveStars(); if(starMarkers.has(s)) starMarkers.get(s).setIcon(makeStarIcon(s)); },
            () => { s.size=next; saveStars(); if(starMarkers.has(s)) starMarkers.get(s).setIcon(makeStarIcon(s)); }
        );
    });

    /* 右クリック削除 */
    marker.on('contextmenu', e => {
        e.originalEvent.preventDefault();
        const i = starData.indexOf(s); if(i!==-1) starData.splice(i,1); saveStars();
        starLayer.removeLayer(marker); starMarkers.delete(s);
        (s.circles||[]).forEach(c => { if(leafletCircles.has(c)){ circleLayer.removeLayer(leafletCircles.get(c)); leafletCircles.delete(c); } });
        pushHistory(`★削除`,
            () => { starData.push(s); saveStars(); addStar(s); (s.circles||[]).forEach(c => addCircle(s,c)); },
            () => {
                const j=starData.indexOf(s); if(j!==-1) starData.splice(j,1); saveStars();
                if(starMarkers.has(s)){ starLayer.removeLayer(starMarkers.get(s)); starMarkers.delete(s); }
                (s.circles||[]).forEach(c => { if(leafletCircles.has(c)){ circleLayer.removeLayer(leafletCircles.get(c)); leafletCircles.delete(c); } });
            }
        );
    });

    /* 既存の円を復元 */
    s.circles.forEach(c => addCircle(s, c));
    return marker;
}

/* =====================================================
   円
   ===================================================== */
function addCircle(s, circleObj){
    const lc = L.circle([circleObj.lat, circleObj.lng], {
        pane: "circlePane",
        radius: circleObj.radiusKm * 1000,
        color: circleObj.color, fillColor: circleObj.color,
        fillOpacity: 0.2, weight: 2
    }).addTo(circleLayer);
    leafletCircles.set(circleObj, lc);

    /* クリック */
    lc.on('click', function(ev){
        /* Shift → 色変更 */
        if(ev.originalEvent && ev.originalEvent.shiftKey){
            const prev = circleObj.color, next = currentColor;
            circleObj.color = next; saveStars();
            this.setStyle({ color:next, fillColor:next });
            pushHistory(`円色変更`,
                () => { circleObj.color=prev; saveStars(); if(leafletCircles.has(circleObj)) leafletCircles.get(circleObj).setStyle({color:prev,fillColor:prev}); },
                () => { circleObj.color=next; saveStars(); if(leafletCircles.has(circleObj)) leafletCircles.get(circleObj).setStyle({color:next,fillColor:next}); }
            );
            return;
        }
        /* 半径変更 */
        const input = prompt("半径（km）", circleObj.radiusKm);
        if(input === null) return;
        const val = Number(input);
        if(!Number.isFinite(val) || val <= 0){ alert("正しい数値を入力してください"); return; }
        const prev = circleObj.radiusKm, next = val;
        circleObj.radiusKm = next; saveStars();
        this.setRadius(next * 1000);
        pushHistory(`円半径変更`,
            () => { circleObj.radiusKm=prev; saveStars(); if(leafletCircles.has(circleObj)) leafletCircles.get(circleObj).setRadius(prev*1000); },
            () => { circleObj.radiusKm=next; saveStars(); if(leafletCircles.has(circleObj)) leafletCircles.get(circleObj).setRadius(next*1000); }
        );
    });

    /* 右クリック削除 */
    lc.on('contextmenu', ev => {
        ev.originalEvent.preventDefault();
        circleLayer.removeLayer(lc); leafletCircles.delete(circleObj);
        const i = s.circles ? s.circles.indexOf(circleObj) : -1;
        if(i !== -1) s.circles.splice(i,1); saveStars();
        pushHistory(`円削除`,
            () => { if(!s.circles) s.circles=[]; s.circles.push(circleObj); saveStars(); addCircle(s,circleObj); },
            () => { const j=s.circles?s.circles.indexOf(circleObj):-1; if(j!==-1) s.circles.splice(j,1); saveStars(); if(leafletCircles.has(circleObj)){ circleLayer.removeLayer(leafletCircles.get(circleObj)); leafletCircles.delete(circleObj); } }
        );
    });

    return lc;
}

/* =====================================================
   一括ラベルサイズ変更
   ===================================================== */
function changeAllLabelSize(){
    const input = prompt("全ラベルサイズ(px)", 12);
    const next = parseFontSize(input);
    if(next === null){ if(input !== null) alert("1〜300 の数字で入力してください。"); return; }
    if(renderedKeys.size === 0){ alert("先に都道府県を選択してください。"); return; }

    const prevSizes = {};
    renderedKeys.forEach(k => { prevSizes[k] = sizeData[k] || 12; });
    renderedKeys.forEach(k => { sizeData[k] = next; });
    saveSizes(); render();

    pushHistory(`文字サイズ一括`,
        () => { renderedKeys.forEach(k => { sizeData[k]=prevSizes[k]; }); saveSizes(); render(); },
        () => { renderedKeys.forEach(k => { sizeData[k]=next; }); saveSizes(); render(); }
    );
}

/* =====================================================
   ラベル表示切替
   ===================================================== */
function hideLabels(){
    const prev = labelVisible;
    labelVisible = false; saveLabelVisible(); labelLayer.clearLayers(); labelMarkers = {};
    pushHistory(`市区町村削除`,
        () => { labelVisible=prev; saveLabelVisible(); render(); },
        () => { labelVisible=false; saveLabelVisible(); labelLayer.clearLayers(); labelMarkers={}; }
    );
}
function showLabels(){
    const prev = labelVisible;
    labelVisible = true; saveLabelVisible(); render();
    pushHistory(`市区町村復活`,
        () => { labelVisible=prev; saveLabelVisible(); render(); },
        () => { labelVisible=true; saveLabelVisible(); render(); }
    );
}

/* =====================================================
   その他
   ===================================================== */
function downloadMap(){
    html2canvas(document.getElementById("map"),{ useCORS:true, scale:2, backgroundColor:null }).then(canvas=>{
        const a = document.createElement("a");
        a.download = "japan_map.png"; a.href = canvas.toDataURL("image/png"); a.click();
    });
}
function resetAll(){
    if(!confirm("全部リセットしますか？")) return;
    ["colors","sizes","stars","labels","labelVisible","labelColors"].forEach(k => localStorage.removeItem(k));
    circleLayer.clearLayers(); location.reload();
}
function escapeHtml(v){
    return String(v).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
}
function parseFontSize(value){
    if(value === null) return null;
    const t = String(value).trim();
    if(!t.length) return null;
    const n = Number(t);
    if(!Number.isInteger(n) || n < 1 || n > 300) return null;
    return n;
}

function toggleLabels(){
    const prev = labelVisible;
    labelVisible = !labelVisible;
    saveLabelVisible();

    if(labelVisible){
        render();
    }else{
        labelLayer.clearLayers();
        labelMarkers = {};
    }

    // ボタン表示変更
    document.getElementById("labelToggleBtn").textContent =
        labelVisible ? "市区町村非表示" : "市区町村表示";

    pushHistory(`市区町村表示切替`,
        () => {
            labelVisible = prev;
            saveLabelVisible();
            if(labelVisible) render();
            else{
                labelLayer.clearLayers();
                labelMarkers = {};
            }
            document.getElementById("labelToggleBtn").textContent =
                labelVisible ? "市区町村非表示" : "市区町村表示";
        },
        () => {
            labelVisible = !prev;
            saveLabelVisible();
            if(labelVisible) render();
            else{
                labelLayer.clearLayers();
                labelMarkers = {};
            }
            document.getElementById("labelToggleBtn").textContent =
                labelVisible ? "市区町村非表示" : "市区町村表示";
        }
    );
}

/* =====================================================
   起動
   ===================================================== */
createPrefUI({ features: PREF_ORDER.map(p => ({ properties:{ N03_001:p } })) });
setTimeout(() => {
    setColor(currentColor);
    document.getElementById("labelToggleBtn").textContent =
        labelVisible ? "市区町村非表示" : "市区町村表示";
}, 100);
starData.forEach(s => addStar(s));

/* =========================
   CSV設定
   ========================= */

// 人数 → 半径（km）
function getRadiusByPeople(n){
    if(n <= 4) return 0.5;
    if(n <= 9) return 1.0;
    if(n <= 24) return 1.5;
    if(n <= 49) return 2.0;
    return 2.5;
}

// フラグ → 色
let FLAG_COLORS = {
    1: "#ff0000",
    2: "#0070ff",
    3: "#00b050"
};


/* =========================
   CSV読み込み
   ========================= */
function loadCSV(files){
    if(!files || files.length === 0) return;

    const reader = new FileReader();
    reader.onload = e => parseCSV(e.target.result);
    reader.readAsText(files[0], "UTF-8");
}


/* =========================
   CSV解析
   ========================= */
function parseCSV(text){
    const lines = text.split(/\r?\n/).filter(l => l.trim() !== "");
    const dataLines = lines.slice(1);

    const added = [];

    dataLines.forEach(line => {
        const cols = line.split(",");
        if(cols.length < 4) return;

        const lat = parseFloat(cols[0]);
        const lng = parseFloat(cols[1]);
        const people = parseInt(cols[2]);
        const flag = parseInt(cols[3]);

        if(!isFinite(lat) || !isFinite(lng)) return;

        const radiusKm = getRadiusByPeople(people);
        const color = FLAG_COLORS[flag] || "#999";

        const obj = {
            lat: lat,
            lng: lng,
            radiusKm: radiusKm,
            color: color
        };

        addCsvCircle(obj);
        added.push(obj);
    });

    // Undo対応
    pushHistory(`CSV読込`,
        () => {
            added.forEach(o => {
                if(leafletCircles.has(o)){
                    circleLayer.removeLayer(leafletCircles.get(o));
                    leafletCircles.delete(o);
                }
            });
        },
        () => {
            added.forEach(o => addCsvCircle(o));
        }
    );
}


/* =========================
   円追加（CSV専用）
   ========================= */
function addCsvCircle(circleObj){
    const lc = L.circle([circleObj.lat, circleObj.lng], {
        pane: "circlePane",
        radius: circleObj.radiusKm * 1000,
        color: circleObj.color,
        fillColor: circleObj.color,
        fillOpacity: 0.7,
        weight: 2
    }).addTo(circleLayer);

    leafletCircles.set(circleObj, lc);

    // クリック
    lc.on('click', function(ev){

        // Shiftで色変更
        if(ev.originalEvent && ev.originalEvent.shiftKey){
            const prev = circleObj.color;
            const next = currentColor;

            circleObj.color = next;
            this.setStyle({ color: next, fillColor: next });

            pushHistory(`円色変更`,
                () => {
                    circleObj.color = prev;
                    if(leafletCircles.has(circleObj)){
                        leafletCircles.get(circleObj).setStyle({color:prev, fillColor:prev});
                    }
                },
                () => {
                    circleObj.color = next;
                    if(leafletCircles.has(circleObj)){
                        leafletCircles.get(circleObj).setStyle({color:next, fillColor:next});
                    }
                }
            );
            return;
        }

        // 半径変更
        const input = prompt("半径（km）", circleObj.radiusKm);
        if(input === null) return;

        const val = Number(input);
        if(!isFinite(val) || val <= 0) return;

        const prev = circleObj.radiusKm;
        circleObj.radiusKm = val;

        this.setRadius(val * 1000);

        pushHistory(`円半径変更`,
            () => {
                circleObj.radiusKm = prev;
                if(leafletCircles.has(circleObj)){
                    leafletCircles.get(circleObj).setRadius(prev * 1000);
                }
            },
            () => {
                circleObj.radiusKm = val;
                if(leafletCircles.has(circleObj)){
                    leafletCircles.get(circleObj).setRadius(val * 1000);
                }
            }
        );
    });

    // 右クリック削除
    lc.on('contextmenu', function(ev){
        ev.originalEvent.preventDefault();

        circleLayer.removeLayer(lc);
        leafletCircles.delete(circleObj);

        pushHistory(`円削除`,
            () => addCsvCircle(circleObj),
            () => {
                if(leafletCircles.has(circleObj)){
                    circleLayer.removeLayer(leafletCircles.get(circleObj));
                    leafletCircles.delete(circleObj);
                }
            }
        );
    });

    return lc;
}