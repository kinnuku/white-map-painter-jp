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
map.createPane("csvPane");
map.createPane("ellipsePane");       /* ★楕円用ペーン */
map.createPane("ellipseHandlePane"); /* ★楕円ハンドル用ペーン */
map.createPane("starPane");
map.createPane("labelPane");
map.createPane("textPane");

map.getPane("polygonPane").style.zIndex      = 300;
map.getPane("circlePane").style.zIndex       = 450;
map.getPane("csvPane").style.zIndex          = 460;
map.getPane("ellipsePane").style.zIndex      = 480; /* ★ circlePane〜starPane の間 */
map.getPane("ellipseHandlePane").style.zIndex= 510; /* ★ starPane のすぐ上 */
map.getPane("starPane").style.zIndex         = 500;
map.getPane("labelPane").style.zIndex        = 550;
map.getPane("textPane").style.zIndex         = 600;

/* csvPane は CSV編集モード時のみ操作可 */
map.getPane("csvPane").style.pointerEvents = "none";

let layerGroup     = L.layerGroup().addTo(map);
let labelLayer     = L.layerGroup().addTo(map);
let starLayer      = L.layerGroup().addTo(map);
let circleLayer    = L.layerGroup().addTo(map);
let csvCircleLayer = L.layerGroup().addTo(map);
let textLayer      = L.layerGroup().addTo(map);

let currentColor = "#e60000";

let colorData      = JSON.parse(localStorage.getItem("colors")       || "{}");
let sizeData       = JSON.parse(localStorage.getItem("sizes")        || "{}");
let starData       = JSON.parse(localStorage.getItem("stars")        || "[]");
let labelPos       = JSON.parse(localStorage.getItem("labels")       || "{}");
let labelVisible   = JSON.parse(localStorage.getItem("labelVisible") ?? "true");
let labelColorData = JSON.parse(localStorage.getItem("labelColors")  || "{}");

let freeTextData   = JSON.parse(localStorage.getItem("freeTexts")    || "[]");
const saveFreeTexts = () => localStorage.setItem("freeTexts", JSON.stringify(freeTextData));

let geoCache     = {};
let renderedKeys = new Set();
let used         = new Set();
let starMode     = false;
let circleMode   = false;
let textMode     = false;
let csvEditMode  = false;
let ellipseMode  = false; /* ★ */

let labelMarkers   = {};
let starMarkers    = new Map();
let leafletCircles = new Map();
let textMarkers    = new Map();
let polygonLayer   = L.layerGroup().addTo(map);

let csvCircleObjects = [];

/* ★ 楕円データ */
let ellipseData      = JSON.parse(localStorage.getItem("ellipses") || "[]");
const saveEllipses   = () => localStorage.setItem("ellipses", JSON.stringify(ellipseData));
const ellipseMarkers = new Map(); /* ellipseObj -> { poly, handleLayer } */
let selectedEllipse  = null;

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

let mapVisible = false;

function toggleJapanMap(){
    if(mapVisible){
        selectAll(false);
        document.getElementById("toggleMapBtn").textContent = "日本地図表示";
    }else{
        selectAll(true);
        document.getElementById("toggleMapBtn").textContent = "日本地図非表示";
    }
    mapVisible = !mapVisible;
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
                    fillColor: colorData[f.properties.N03_007]
                        || f.properties.color
                        || "#fff",
                    fillOpacity:1
                }),
                onEachFeature: (f, layer) => {
                    const key      = f.properties.N03_007;
                    const name     = getName(f);
                    const safeName = escapeHtml(name || "");
                    if(!name) return;
                    renderedKeys.add(key);

                    layer.on('click', () => {
                        if (starMode || circleMode || textMode || ellipseMode) return;
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
    textLayer.bringToFront();
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

    marker.on('click', e => {
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
function toggleStarMode(forceValue=null){
    if(forceValue === null){
        starMode = !starMode;
    }else{
        starMode = forceValue;
    }
    document.getElementById("starBtn").classList.toggle("active", starMode);
    if(starMode){
        toggleCircleMode(false);
        toggleTextMode(false);
        toggleCsvEditMode(false);
        toggleEllipseMode(false); /* ★ */
    }
    /* starPane は常にクリック可能（円モードでも星をクリックして円を追加するため） */
    map.getPane("starPane").style.pointerEvents = "auto";
}

function setCircleInteractive(flag){
    leafletCircles.forEach(c => {
        if(c._path){
            if(flag){
                L.DomUtil.removeClass(c._path, "leaflet-interactive");
                c._path.classList.add("leaflet-interactive");
            }else{
                c._path.classList.remove("leaflet-interactive");
            }
        }
    });
}

/* =====================================================
   円モード
   ===================================================== */
function toggleCircleMode(forceValue=null){
    if(forceValue === null){
        circleMode = !circleMode;
    }else{
        circleMode = forceValue;
    }
    document.getElementById("circleBtn").classList.toggle("active", circleMode);
    if(circleMode){
        starMode = false;
        document.getElementById("starBtn").classList.remove("active");
        toggleTextMode(false);
        toggleCsvEditMode(false);
        toggleEllipseMode(false); /* ★ */
    }
    const pane = map.getPane("circlePane");
    pane.style.pointerEvents = circleMode ? "auto" : "none";
}

function makeStarIcon(s){
    return L.divIcon({
        className:'star-icon',
        html:`<div style="font-size:${s.size}px;color:${s.color};text-shadow:1px 1px 2px #000;">★</div>`,
        iconAnchor:null
    });
}

/* =====================================================
   地図クリックハンドラ（星・テキスト・楕円）
   ===================================================== */
map.on('click', e => {
    /* フリーテキストモード */
    if(textMode){
        const inputText = prompt("テキストを入力してください", "テキスト");
        if(inputText === null || inputText.trim() === "") return;
        const sizeInput = prompt("フォントサイズ(px)", 16);
        const sz = parseFontSize(sizeInput);
        if(sz === null){ if(sizeInput !== null) alert("1〜300 の数字で入力してください。"); return; }

        const t = {
            lat: e.latlng.lat,
            lng: e.latlng.lng,
            text: inputText.trim(),
            size: sz,
            color: "#000000"
        };
        freeTextData.push(t);
        saveFreeTexts();
        addFreeText(t);
        toggleTextMode(false);

        pushHistory(`テキスト追加`,
            () => {
                const i = freeTextData.indexOf(t);
                if(i !== -1) freeTextData.splice(i, 1);
                saveFreeTexts();
                if(textMarkers.has(t)){ textLayer.removeLayer(textMarkers.get(t)); textMarkers.delete(t); }
            },
            () => { freeTextData.push(t); saveFreeTexts(); addFreeText(t); }
        );
        return;
    }

    /* 楕円モード */
    if(ellipseMode){
        /* 楕円・ハンドル上のクリックは stopPropagation するのでここには来ない */
        /* 選択中のハンドルを解除 */
        if(selectedEllipse){
            deselectEllipse();
            return;
        }
        /* 新規追加 */
        const obj = {
            lat:     e.latlng.lat,
            lng:     e.latlng.lng,
            rxKm:    30,
            ryKm:    15,
            rot:     0,
            color:   currentColor,
            opacity: 0.3
        };
        ellipseData.push(obj);
        saveEllipses();
        addEllipse(obj);
        selectEllipse(obj);

        pushHistory("楕円追加",
            () => {
                deselectEllipse();
                const i = ellipseData.indexOf(obj);
                if(i !== -1) ellipseData.splice(i, 1);
                saveEllipses();
                removeEllipseLayer(obj);
            },
            () => { ellipseData.push(obj); saveEllipses(); addEllipse(obj); }
        );
        return;
    }

    /* 星モード */
    if(!starMode) return;
    const input = prompt("星サイズ(px)", 20);
    const sz = parseFontSize(input);
    if(sz === null){ if(input !== null) alert("1〜300 の数字で入力してください。"); return; }

    const s = { lat:e.latlng.lat, lng:e.latlng.lng, size:sz, color:"#ffd700", circles:[] };
    starData.push(s); saveStars();
    addStar(s);
    toggleStarMode(false);

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

    marker.on('click', e => {
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
            toggleCircleMode(false);
            return;
        }
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
        color: circleObj.color,
        fillColor: circleObj.color,
        fillOpacity: 0.2,
        weight: 2,
        interactive: true,
    }).addTo(circleLayer);

    leafletCircles.set(circleObj, lc);

    lc.on('click', function(ev){
        if(!circleMode) return;
        if(ev.originalEvent && ev.originalEvent.shiftKey){
            const prev = circleObj.color, next = currentColor;
            circleObj.color = next;
            saveStars();
            this.setStyle({ color: next, fillColor: next });
            pushHistory(`円色変更`,
                () => { circleObj.color = prev; saveStars(); if(leafletCircles.has(circleObj)) leafletCircles.get(circleObj).setStyle({color:prev,fillColor:prev}); },
                () => { circleObj.color = next; saveStars(); if(leafletCircles.has(circleObj)) leafletCircles.get(circleObj).setStyle({color:next,fillColor:next}); }
            );
            return;
        }
        const input = prompt("半径（km）", circleObj.radiusKm);
        if(input === null) return;
        const val = Number(input);
        if(!Number.isFinite(val) || val <= 0){ alert("正しい数値を入力してください"); return; }
        const prev = circleObj.radiusKm;
        const next = val;
        circleObj.radiusKm = next; saveStars();
        this.setRadius(next * 1000);
        pushHistory(`円半径変更`,
            () => { circleObj.radiusKm=prev; saveStars(); if(leafletCircles.has(circleObj)) leafletCircles.get(circleObj).setRadius(prev*1000); },
            () => { circleObj.radiusKm=next; saveStars(); if(leafletCircles.has(circleObj)) leafletCircles.get(circleObj).setRadius(next*1000); }
        );
    });

    lc.on('contextmenu', ev => {
        if(!circleMode) return;
        ev.originalEvent.preventDefault();
        circleLayer.removeLayer(lc);
        leafletCircles.delete(circleObj);
        const i = s.circles ? s.circles.indexOf(circleObj) : -1;
        if(i !== -1) s.circles.splice(i,1);
        saveStars();
        pushHistory(`円削除`,
            () => { if(!s.circles) s.circles=[]; s.circles.push(circleObj); saveStars(); addCircle(s,circleObj); },
            () => {
                const j = s.circles ? s.circles.indexOf(circleObj) : -1;
                if(j !== -1) s.circles.splice(j,1);
                saveStars();
                if(leafletCircles.has(circleObj)){ circleLayer.removeLayer(leafletCircles.get(circleObj)); leafletCircles.delete(circleObj); }
            }
        );
    });

    return lc;
}

/* =====================================================
   フリーテキスト
   ===================================================== */
function toggleTextMode(forceValue=null){
    if(forceValue === null){
        textMode = !textMode;
    }else{
        textMode = forceValue;
    }
    document.getElementById("textBtn").classList.toggle("active", textMode);
    if(textMode){
        toggleStarMode(false);
        toggleCircleMode(false);
        toggleCsvEditMode(false);
        toggleEllipseMode(false); /* ★ */
    }
    map.getPane("textPane").style.pointerEvents = "auto";
}

/* =====================================================
   CSV編集モード
   ===================================================== */
function toggleCsvEditMode(forceValue=null){
    if(forceValue === null){
        csvEditMode = !csvEditMode;
    }else{
        csvEditMode = forceValue;
    }
    document.getElementById("csvEditBtn").classList.toggle("active", csvEditMode);
    if(csvEditMode){
        toggleStarMode(false);
        toggleCircleMode(false);
        toggleTextMode(false);
        toggleEllipseMode(false); /* ★ */
    }
    map.getPane("csvPane").style.pointerEvents = csvEditMode ? "auto" : "none";
}

function makeTextIcon(t){
    return L.divIcon({
        className: 'free-text-icon',
        html: `<div class="free-text-inner" style="font-size:${t.size}px;color:${t.color};">${escapeHtml(t.text)}</div>`,
        iconAnchor: [0, 0]
    });
}

function addFreeText(t){
    const marker = L.marker([t.lat, t.lng], {
        pane: "textPane",
        draggable: true,
        icon: makeTextIcon(t)
    }).addTo(textLayer);

    textMarkers.set(t, marker);

    let dragFrom = null;
    marker.on('dragstart', () => { dragFrom = marker.getLatLng(); });
    marker.on('dragend', e => {
        const to = e.target.getLatLng(), from = dragFrom;
        t.lat = to.lat; t.lng = to.lng; saveFreeTexts();
        pushHistory(`テキスト移動`,
            () => { t.lat=from.lat; t.lng=from.lng; saveFreeTexts(); if(textMarkers.has(t)) textMarkers.get(t).setLatLng(from); },
            () => { t.lat=to.lat;   t.lng=to.lng;   saveFreeTexts(); if(textMarkers.has(t)) textMarkers.get(t).setLatLng(to); }
        );
    });

    marker.on('click', e => {
        if(e.originalEvent.shiftKey){
            const prev = t.color, next = currentColor;
            t.color = next; saveFreeTexts();
            marker.setIcon(makeTextIcon(t));
            pushHistory(`テキスト色変更`,
                () => { t.color=prev; saveFreeTexts(); if(textMarkers.has(t)) textMarkers.get(t).setIcon(makeTextIcon(t)); },
                () => { t.color=next; saveFreeTexts(); if(textMarkers.has(t)) textMarkers.get(t).setIcon(makeTextIcon(t)); }
            );
            return;
        }

        const choice = prompt(
            `編集内容を選択\n1: テキスト変更\n2: サイズ変更\n（現在: "${t.text}" / ${t.size}px）`,
            "1"
        );
        if(choice === null) return;

        if(choice === "1"){
            const newText = prompt("新しいテキスト", t.text);
            if(newText === null || newText.trim() === "") return;
            const prev = t.text, next = newText.trim();
            t.text = next; saveFreeTexts();
            marker.setIcon(makeTextIcon(t));
            pushHistory(`テキスト編集`,
                () => { t.text=prev; saveFreeTexts(); if(textMarkers.has(t)) textMarkers.get(t).setIcon(makeTextIcon(t)); },
                () => { t.text=next; saveFreeTexts(); if(textMarkers.has(t)) textMarkers.get(t).setIcon(makeTextIcon(t)); }
            );
        } else if(choice === "2"){
            const sizeInput = prompt("フォントサイズ(px)", t.size);
            const next = parseFontSize(sizeInput);
            if(next === null){ if(sizeInput !== null) alert("1〜300 の数字で入力してください。"); return; }
            const prev = t.size;
            t.size = next; saveFreeTexts();
            marker.setIcon(makeTextIcon(t));
            pushHistory(`テキストサイズ変更`,
                () => { t.size=prev; saveFreeTexts(); if(textMarkers.has(t)) textMarkers.get(t).setIcon(makeTextIcon(t)); },
                () => { t.size=next; saveFreeTexts(); if(textMarkers.has(t)) textMarkers.get(t).setIcon(makeTextIcon(t)); }
            );
        }
    });

    marker.on('contextmenu', e => {
        e.originalEvent.preventDefault();
        const i = freeTextData.indexOf(t);
        if(i !== -1) freeTextData.splice(i, 1);
        saveFreeTexts();
        textLayer.removeLayer(marker);
        textMarkers.delete(t);
        pushHistory(`テキスト削除`,
            () => { freeTextData.push(t); saveFreeTexts(); addFreeText(t); },
            () => {
                const j = freeTextData.indexOf(t);
                if(j !== -1) freeTextData.splice(j, 1);
                saveFreeTexts();
                if(textMarkers.has(t)){ textLayer.removeLayer(textMarkers.get(t)); textMarkers.delete(t); }
            }
        );
    });

    return marker;
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

    document.getElementById("labelToggleBtn").textContent =
        labelVisible ? "市区町村名非表示" : "市区町村名表示";

    pushHistory(`市区町村表示切替`,
        () => {
            labelVisible = prev;
            saveLabelVisible();
            if(labelVisible) render();
            else{ labelLayer.clearLayers(); labelMarkers = {}; }
            document.getElementById("labelToggleBtn").textContent =
                labelVisible ? "市区町村名非表示" : "市区町村名表示";
        },
        () => {
            labelVisible = !prev;
            saveLabelVisible();
            if(labelVisible) render();
            else{ labelLayer.clearLayers(); labelMarkers = {}; }
            document.getElementById("labelToggleBtn").textContent =
                labelVisible ? "市区町村名非表示" : "市区町村名表示";
        }
    );
}

/* =====================================================
   CSV円の一括削除
   ===================================================== */
function clearAllCsvCircles(){
    if(csvCircleObjects.length === 0){ alert("削除するCSVピンがありません。"); return; }
    if(!confirm(`CSV読込のピンを全て削除しますか？（${csvCircleObjects.length}件）`)) return;

    const removed = [...csvCircleObjects];
    removed.forEach(o => {
        if(leafletCircles.has(o)){
            csvCircleLayer.removeLayer(leafletCircles.get(o));
            leafletCircles.delete(o);
        }
    });
    csvCircleObjects = [];

    pushHistory(`CSV一括削除`,
        () => { removed.forEach(o => { addCsvCircle(o); csvCircleObjects.push(o); }); },
        () => {
            removed.forEach(o => {
                if(leafletCircles.has(o)){ csvCircleLayer.removeLayer(leafletCircles.get(o)); leafletCircles.delete(o); }
            });
            csvCircleObjects = [];
        }
    );
}

/* =====================================================
   その他ユーティリティ
   ===================================================== */
function downloadMap(){
    html2canvas(document.querySelector("#map")).then(canvas=>{
        const a = document.createElement("a");
        a.download = "map.png";
        a.href = canvas.toDataURL();
        a.click();
    });
}
function resetAll(){
    if(!confirm("全部リセットしますか？")) return;
    ["colors","sizes","stars","labels","labelVisible","labelColors","freeTexts","ellipses"].forEach(k => localStorage.removeItem(k));
    circleLayer.clearLayers();
    location.reload();
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

/* =====================================================
   CSV設定
   ===================================================== */
function getRadiusByPeople(n){
    if(n <= 1) return 0.1;
    if(n <= 2) return 0.2;
    if(n <= 3) return 0.3;
    if(n <= 4) return 0.4;
    if(n <= 5) return 0.5;
    if(n <= 10) return 0.7;
    if(n <= 25) return 1.0;
    if(n <= 50) return 1.2;
    return 1.5;
}

let FLAG_COLORS = {
    1: "#ff0000",
    2: "#0070ff",
    3: "#00b050",
    4: "#ff9900",
    5: "#ffff00"
};

/* =====================================================
   CSV読み込み
   ===================================================== */
function loadCSV(files){
    if(!files || files.length === 0) return;
    const reader = new FileReader();
    reader.onload = e => parseCSV(e.target.result);
    reader.readAsText(files[0], "UTF-8");
}

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
        const obj = { lat, lng, radiusKm, color };

        addCsvCircle(obj);
        added.push(obj);
        csvCircleObjects.push(obj);
    });

    pushHistory(`CSV読込`,
        () => {
            added.forEach(o => {
                if(leafletCircles.has(o)){ csvCircleLayer.removeLayer(leafletCircles.get(o)); leafletCircles.delete(o); }
                const i = csvCircleObjects.indexOf(o);
                if(i !== -1) csvCircleObjects.splice(i, 1);
            });
        },
        () => {
            added.forEach(o => { addCsvCircle(o); csvCircleObjects.push(o); });
        }
    );
}

/* =====================================================
   CSV円追加
   ===================================================== */
function addCsvCircle(circleObj){
    const lc = L.circle([circleObj.lat, circleObj.lng], {
        pane: "csvPane",
        radius: circleObj.radiusKm * 1000,
        color: circleObj.color,
        fillColor: circleObj.color,
        fillOpacity: 0.7,
        weight: 2,
        interactive: true,
    }).addTo(csvCircleLayer);

    leafletCircles.set(circleObj, lc);

    lc.on('click', function(ev){
        if(ev.originalEvent && ev.originalEvent.shiftKey){
            const prev = circleObj.color, next = currentColor;
            circleObj.color = next;
            this.setStyle({ color: next, fillColor: next });
            pushHistory(`円色変更`,
                () => { circleObj.color=prev; if(leafletCircles.has(circleObj)) leafletCircles.get(circleObj).setStyle({color:prev,fillColor:prev}); },
                () => { circleObj.color=next; if(leafletCircles.has(circleObj)) leafletCircles.get(circleObj).setStyle({color:next,fillColor:next}); }
            );
            return;
        }
        const input = prompt("半径（km）", circleObj.radiusKm);
        if(input === null) return;
        const val = Number(input);
        if(!isFinite(val) || val <= 0) return;
        const prev = circleObj.radiusKm;
        circleObj.radiusKm = val;
        this.setRadius(val * 1000);
        pushHistory(`円半径変更`,
            () => { circleObj.radiusKm=prev; if(leafletCircles.has(circleObj)) leafletCircles.get(circleObj).setRadius(prev*1000); },
            () => { circleObj.radiusKm=val;  if(leafletCircles.has(circleObj)) leafletCircles.get(circleObj).setRadius(val*1000); }
        );
    });

    lc.on('contextmenu', function(ev){
        ev.originalEvent.preventDefault();
        csvCircleLayer.removeLayer(lc);
        leafletCircles.delete(circleObj);

        const idx = csvCircleObjects.indexOf(circleObj);
        if(idx !== -1) csvCircleObjects.splice(idx, 1);

        pushHistory(`CSVピン削除`,
            () => { addCsvCircle(circleObj); csvCircleObjects.push(circleObj); },
            () => {
                const j = csvCircleObjects.indexOf(circleObj);
                if(j !== -1) csvCircleObjects.splice(j, 1);
                if(leafletCircles.has(circleObj)){ csvCircleLayer.removeLayer(leafletCircles.get(circleObj)); leafletCircles.delete(circleObj); }
            }
        );
    });

    return lc;
}

/* =====================================================
   ★ 楕円機能
   =====================================================

   ハンドル構成（楕円モード中に楕円をクリックで出現）:
     ●  長軸端 2点 … ドラッグで長軸を伸縮
     ●  短軸端 2点 … ドラッグで短軸を伸縮
     ↻  回転ハンドル (長軸端の外側) … ドラッグで回転
     ✛  中心ハンドル … ドラッグで移動

   操作:
     楕円モード中 地図クリック → 楕円新規追加（長軸30km・短軸15km）
     楕円クリック              → ハンドル表示
     ハンドルドラッグ          → リアルタイム変形 / 移動 / 回転
     Shift + 楕円クリック      → 色変更（選択中の色）
     右クリック                → 削除
     ハンドル外クリック        → ハンドル解除
   ===================================================== */

const EARTH_R = 6371; // km

/* ----- モード切替 ----- */
function toggleEllipseMode(forceValue = null){
    ellipseMode = forceValue !== null ? forceValue : !ellipseMode;
    const btn = document.getElementById("ellipseBtn");
    if(btn) btn.classList.toggle("active", ellipseMode);
    if(ellipseMode){
        toggleStarMode(false);
        toggleCircleMode(false);
        toggleTextMode(false);
        toggleCsvEditMode(false);
    } else {
        deselectEllipse();
    }
}

/* ----- ハンドル解除 ----- */
function deselectEllipse(){
    if(!selectedEllipse) return;
    const rec = ellipseMarkers.get(selectedEllipse);
    if(rec) rec.handleLayer.clearLayers();
    selectedEllipse = null;
}

/* ----- 楕円の点列計算 ----- */
function ellipseLatLngs(lat, lng, rxKm, ryKm, rotDeg, N = 360){
    const rotRad = (rotDeg * Math.PI) / 180;
    const latRad = (lat    * Math.PI) / 180;
    const pts    = [];
    for(let i = 0; i < N; i++){
        const theta  = (2 * Math.PI * i) / N;
        const xLocal =  rxKm * Math.cos(theta);
        const yLocal =  ryKm * Math.sin(theta);
        const xRot   =  xLocal * Math.cos(rotRad) - yLocal * Math.sin(rotRad);
        const yRot   =  xLocal * Math.sin(rotRad) + yLocal * Math.cos(rotRad);
        const dLat   = (yRot / EARTH_R) * (180 / Math.PI);
        const dLng   = (xRot / EARTH_R) * (180 / Math.PI) / Math.cos(latRad);
        pts.push([lat + dLat, lng + dLng]);
    }
    return pts;
}

/* 楕円上の1点（theta は局所座標系）→ LatLng */
function ellipsePoint(lat, lng, rxKm, ryKm, rotDeg, theta){
    const rotRad = (rotDeg * Math.PI) / 180;
    const latRad = (lat    * Math.PI) / 180;
    const xLocal =  rxKm  * Math.cos(theta);
    const yLocal =  ryKm  * Math.sin(theta);
    const xRot   =  xLocal * Math.cos(rotRad) - yLocal * Math.sin(rotRad);
    const yRot   =  xLocal * Math.sin(rotRad) + yLocal * Math.cos(rotRad);
    const dLat   = (yRot / EARTH_R) * (180 / Math.PI);
    const dLng   = (xRot / EARTH_R) * (180 / Math.PI) / Math.cos(latRad);
    return L.latLng(lat + dLat, lng + dLng);
}

/* ----- 楕円レイヤー追加 ----- */
function addEllipse(obj){
    const poly = L.polygon(ellipseLatLngs(obj.lat, obj.lng, obj.rxKm, obj.ryKm, obj.rot), {
        pane:        "ellipsePane",
        color:       obj.color,
        fillColor:   obj.color,
        fillOpacity: obj.opacity !== undefined ? obj.opacity : 0.3,
        weight:      2,
        interactive: true
    }).addTo(map);

    const handleLayer = L.layerGroup().addTo(map);
    ellipseMarkers.set(obj, { poly, handleLayer });

    poly.on('click', function(e){
        L.DomEvent.stopPropagation(e);
        if(!ellipseMode) return;

        /* Shift → 色変更 */
        if(e.originalEvent.shiftKey){
            const prev = obj.color, next = currentColor;
            obj.color = next; saveEllipses();
            poly.setStyle({ color: next, fillColor: next });
            pushHistory("楕円色変更",
                () => { obj.color = prev; saveEllipses(); poly.setStyle({ color: prev, fillColor: prev }); },
                () => { obj.color = next; saveEllipses(); poly.setStyle({ color: next, fillColor: next }); }
            );
            return;
        }

        /* ハンドル表示 / 解除 */
        if(selectedEllipse === obj){
            deselectEllipse();
        } else {
            deselectEllipse();
            selectEllipse(obj);
        }
    });

    poly.on('contextmenu', function(e){
        e.originalEvent.preventDefault();
        L.DomEvent.stopPropagation(e);
        if(!ellipseMode) return;
        deselectEllipse();
        const i = ellipseData.indexOf(obj);
        if(i !== -1) ellipseData.splice(i, 1);
        saveEllipses();
        removeEllipseLayer(obj);
        pushHistory("楕円削除",
            () => { ellipseData.push(obj); saveEllipses(); addEllipse(obj); },
            () => {
                const j = ellipseData.indexOf(obj);
                if(j !== -1) ellipseData.splice(j, 1);
                saveEllipses(); removeEllipseLayer(obj);
            }
        );
    });

    return poly;
}

/* ----- ハンドル表示 ----- */
function selectEllipse(obj){
    selectedEllipse = obj;
    const rec = ellipseMarkers.get(obj);
    if(!rec) return;
    _buildHandles(obj, rec);
}

/* ---- ハンドルアイコン ---- */
function _axisHandleIcon(){
    return L.divIcon({
        className: "",
        html: `<div style="
            width:14px;height:14px;background:#fff;
            border:2px solid #333;border-radius:50%;
            cursor:grab;box-shadow:0 1px 4px rgba(0,0,0,.5);
        "></div>`,
        iconSize: [14,14], iconAnchor: [7,7]
    });
}
function _rotHandleIcon(){
    return L.divIcon({
        className: "",
        html: `<div style="
            width:16px;height:16px;background:#ffd700;
            border:2px solid #888;border-radius:50%;
            cursor:crosshair;box-shadow:0 1px 4px rgba(0,0,0,.5);
            display:flex;align-items:center;justify-content:center;font-size:11px;
        ">↻</div>`,
        iconSize: [16,16], iconAnchor: [8,8]
    });
}
function _moveHandleIcon(){
    return L.divIcon({
        className: "",
        html: `<div style="
            width:16px;height:16px;background:#4af;
            border:2px solid #055;border-radius:3px;
            cursor:move;box-shadow:0 1px 4px rgba(0,0,0,.5);
            display:flex;align-items:center;justify-content:center;font-size:11px;
        ">✛</div>`,
        iconSize: [16,16], iconAnchor: [8,8]
    });
}

/* ---- ハンドル構築 ---- */
function _buildHandles(obj, rec){
    rec.handleLayer.clearLayers();

    /* 軸ハンドル 4点 */
    [
        { key: "rx+", theta: 0 },
        { key: "rx-", theta: Math.PI },
        { key: "ry+", theta: Math.PI / 2 },
        { key: "ry-", theta: 3 * Math.PI / 2 }
    ].forEach(({ key, theta }) => {
        const m = L.marker(ellipsePoint(obj.lat, obj.lng, obj.rxKm, obj.ryKm, obj.rot, theta), {
            pane: "ellipseHandlePane",
            icon: _axisHandleIcon(),
            draggable: true,
            zIndexOffset: 1000
        }).addTo(rec.handleLayer);
        m._ellipseHandleKey = key;

        let snap = null;
        m.on('dragstart', () => { snap = { rxKm: obj.rxKm, ryKm: obj.ryKm }; map.dragging.disable(); });
        m.on('drag', function(e){
            _applyAxisHandle(obj, key, e.target.getLatLng());
            ellipseMarkers.get(obj).poly.setLatLngs(
                ellipseLatLngs(obj.lat, obj.lng, obj.rxKm, obj.ryKm, obj.rot));
            _updateHandlePositions(obj, rec);
        });
        m.on('dragend', function(){
            map.dragging.enable();
            saveEllipses();
            const after = { rxKm: obj.rxKm, ryKm: obj.ryKm }, before = snap;
            pushHistory("楕円変形",
                () => { Object.assign(obj, before); saveEllipses(); _refreshEllipse(obj); },
                () => { Object.assign(obj, after);  saveEllipses(); _refreshEllipse(obj); }
            );
        });
        m.on('click', e => L.DomEvent.stopPropagation(e));
    });

    /* 回転ハンドル */
    const ROT_EXTRA = Math.max(obj.rxKm * 0.4, 5);
    const rotM = L.marker(
        ellipsePoint(obj.lat, obj.lng, obj.rxKm + ROT_EXTRA, 0, obj.rot, 0),
        { pane: "ellipseHandlePane", icon: _rotHandleIcon(), draggable: true, zIndexOffset: 1000 }
    ).addTo(rec.handleLayer);
    rotM._ellipseHandleKey = "rot";

    let rotSnap = null;
    rotM.on('dragstart', () => { rotSnap = obj.rot; map.dragging.disable(); });
    rotM.on('drag', function(e){
        const cPx = map.latLngToContainerPoint(L.latLng(obj.lat, obj.lng));
        const hPx = map.latLngToContainerPoint(e.target.getLatLng());
        const dx  =  hPx.x - cPx.x;
        const dy  = -(hPx.y - cPx.y);
        obj.rot   = (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360;
        ellipseMarkers.get(obj).poly.setLatLngs(
            ellipseLatLngs(obj.lat, obj.lng, obj.rxKm, obj.ryKm, obj.rot));
        _updateHandlePositions(obj, rec);
    });
    rotM.on('dragend', function(){
        map.dragging.enable();
        saveEllipses();
        const after = obj.rot, before = rotSnap;
        pushHistory("楕円回転",
            () => { obj.rot = before; saveEllipses(); _refreshEllipse(obj); },
            () => { obj.rot = after;  saveEllipses(); _refreshEllipse(obj); }
        );
    });
    rotM.on('click', e => L.DomEvent.stopPropagation(e));

    /* 中心（移動）ハンドル */
    const cM = L.marker([obj.lat, obj.lng], {
        pane: "ellipseHandlePane",
        icon: _moveHandleIcon(),
        draggable: true,
        zIndexOffset: 1000
    }).addTo(rec.handleLayer);
    cM._ellipseHandleKey = "move";

    let moveSnap = null;
    cM.on('dragstart', () => { moveSnap = { lat: obj.lat, lng: obj.lng }; map.dragging.disable(); });
    cM.on('drag', function(e){
        const ll = e.target.getLatLng();
        obj.lat  = ll.lat; obj.lng = ll.lng;
        ellipseMarkers.get(obj).poly.setLatLngs(
            ellipseLatLngs(obj.lat, obj.lng, obj.rxKm, obj.ryKm, obj.rot));
        _updateHandlePositions(obj, rec);
    });
    cM.on('dragend', function(){
        map.dragging.enable();
        saveEllipses();
        const after = { lat: obj.lat, lng: obj.lng }, before = moveSnap;
        pushHistory("楕円移動",
            () => { obj.lat = before.lat; obj.lng = before.lng; saveEllipses(); _refreshEllipse(obj); },
            () => { obj.lat = after.lat;  obj.lng = after.lng;  saveEllipses(); _refreshEllipse(obj); }
        );
    });
    cM.on('click', e => L.DomEvent.stopPropagation(e));
}

/* ----- 軸ハンドル → rxKm / ryKm 更新 ----- */
function _applyAxisHandle(obj, key, dragLL){
    const latRad = (obj.lat * Math.PI) / 180;
    const dLat   = dragLL.lat - obj.lat;
    const dLng   = dragLL.lng - obj.lng;
    const dy     =  dLat * (Math.PI / 180) * EARTH_R;
    const dx     =  dLng * (Math.PI / 180) * EARTH_R * Math.cos(latRad);
    const rotRad = (obj.rot * Math.PI) / 180;
    const xLocal =  dx * Math.cos(rotRad) + dy * Math.sin(rotRad);
    const yLocal = -dx * Math.sin(rotRad) + dy * Math.cos(rotRad);

    if     (key === "rx+") obj.rxKm = Math.max(0.5, xLocal);
    else if(key === "rx-") obj.rxKm = Math.max(0.5, -xLocal);
    else if(key === "ry+") obj.ryKm = Math.max(0.5, yLocal);
    else if(key === "ry-") obj.ryKm = Math.max(0.5, -yLocal);
}

/* ----- ハンドル位置だけ更新 ----- */
function _updateHandlePositions(obj, rec){
    if(!rec) return;
    const thetaMap = { "rx+": 0, "rx-": Math.PI, "ry+": Math.PI/2, "ry-": 3*Math.PI/2 };
    const ROT_EXTRA = Math.max(obj.rxKm * 0.4, 5);
    rec.handleLayer.eachLayer(m => {
        const k = m._ellipseHandleKey;
        if(!k) return;
        if(k in thetaMap){
            m.setLatLng(ellipsePoint(obj.lat, obj.lng, obj.rxKm, obj.ryKm, obj.rot, thetaMap[k]));
        } else if(k === "rot"){
            m.setLatLng(ellipsePoint(obj.lat, obj.lng, obj.rxKm + ROT_EXTRA, 0, obj.rot, 0));
        } else if(k === "move"){
            m.setLatLng(L.latLng(obj.lat, obj.lng));
        }
    });
}

/* ----- 楕円を全体再描画（undo/redo後など） ----- */
function _refreshEllipse(obj){
    const rec = ellipseMarkers.get(obj);
    if(!rec) return;
    rec.poly.setLatLngs(ellipseLatLngs(obj.lat, obj.lng, obj.rxKm, obj.ryKm, obj.rot));
    rec.poly.setStyle({ color: obj.color, fillColor: obj.color, fillOpacity: obj.opacity || 0.3 });
    if(selectedEllipse === obj){
        _buildHandles(obj, rec);
    } else {
        rec.handleLayer.clearLayers();
    }
}

/* ----- 楕円レイヤー削除 ----- */
function removeEllipseLayer(obj){
    const rec = ellipseMarkers.get(obj);
    if(!rec) return;
    map.removeLayer(rec.poly);
    rec.handleLayer.clearLayers();
    map.removeLayer(rec.handleLayer);
    ellipseMarkers.delete(obj);
    if(selectedEllipse === obj) selectedEllipse = null;
}

/* =====================================================
   起動
   ===================================================== */
createPrefUI({ features: PREF_ORDER.map(p => ({ properties:{ N03_001:p } })) });
setTimeout(() => {
    setColor(currentColor);
    document.getElementById("labelToggleBtn").textContent =
        labelVisible ? "市区町村名非表示" : "市区町村名表示";
}, 100);
starData.forEach(s => addStar(s));
freeTextData.forEach(t => addFreeText(t));
ellipseData.forEach(obj => addEllipse(obj)); /* ★ 保存済み楕円を復元 */

toggleCircleMode(false);
toggleStarMode(false);
toggleTextMode(false);
toggleCsvEditMode(false);
toggleEllipseMode(false); /* ★ */
