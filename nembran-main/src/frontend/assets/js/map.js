import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

window['AuditMap'] = (() => {
  const SOURCE = 'audit-areas';
  const FILL_LAYER = 'audit-fill';
  const LINE_LAYER = 'audit-line';
  const HOVER_FILL = 'audit-fill-hover';
  const HOVER_LINE = 'audit-line-hover';

  let map = null;
  let popup = null;
  let hoveredId = null;
  let _isProvinceView = false;
  let _onAreaClick = null;
  let _getPopupHtml = null;
  let _focusMarker = null;
  let _focusMarkerPopup = null;

  function getFeatureAreaKey(props) {
    return _isProvinceView ? props.provinceKey : props.regionKey;
  }

  function buildStyledGeo(geo, getFeatureStyle) {
    return {
      type: 'FeatureCollection',
      features: geo.features.map((f) => ({
        type: 'Feature',
        geometry: f.geometry,
        properties: { ...f.properties, ...getFeatureStyle(f) },
      })),
    };
  }

  function walkCoords(geometry, fn) {
    const c = geometry.coordinates;
    if (geometry.type === 'Point') {
      fn(c[0], c[1]);
    } else if (geometry.type === 'LineString' || geometry.type === 'MultiPoint') {
      c.forEach((p) => fn(p[0], p[1]));
    } else if (geometry.type === 'Polygon' || geometry.type === 'MultiLineString') {
      c.forEach((ring) => ring.forEach((p) => fn(p[0], p[1])));
    } else if (geometry.type === 'MultiPolygon') {
      c.forEach((poly) => poly.forEach((ring) => ring.forEach((p) => fn(p[0], p[1]))));
    }
  }

  function computeBounds(geo) {
    let minLng = Infinity,
      minLat = Infinity,
      maxLng = -Infinity,
      maxLat = -Infinity;
    let hasCoords = false;
    geo.features.forEach((f) => {
      if (!f.geometry) return;
      walkCoords(f.geometry, (lng, lat) => {
        hasCoords = true;
        if (lng < minLng) minLng = lng;
        if (lat < minLat) minLat = lat;
        if (lng > maxLng) maxLng = lng;
        if (lat > maxLat) maxLat = lat;
      });
    });
    return hasCoords
      ? [
          [minLng, minLat],
          [maxLng, maxLat],
        ]
      : null;
  }

  function ensureMap(container) {
    if (map) return;
    map = new maplibregl.Map({
      container,
      center: [118, -2.5],
      zoom: 5,
      minZoom: 4,
      maxZoom: 12,
      style: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
    });
  }

  function closePopup() {
    if (popup) {
      popup.remove();
      popup = null;
    }
  }

  function clearHover() {
    if (hoveredId !== null) {
      try {
        map.setFeatureState({ source: SOURCE, id: hoveredId }, { hover: false });
      } catch (e) {
        console.warn('Failed to clear hover state:', e);
      }
      hoveredId = null;
    }
    closePopup();
  }

  function addLayers() {
    map.addSource(SOURCE, {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
      generateId: true,
    });

    map.addLayer({
      id: FILL_LAYER,
      type: 'fill',
      source: SOURCE,
      paint: {
        'fill-color': ['coalesce', ['get', 'fillColor'], '#243155'],
        'fill-opacity': ['coalesce', ['get', 'fillOpacity'], 0.08],
      },
    });

    map.addLayer({
      id: LINE_LAYER,
      type: 'line',
      source: SOURCE,
      paint: {
        'line-color': ['coalesce', ['get', 'strokeColor'], '#b5a882'],
        'line-width': ['coalesce', ['get', 'strokeWidth'], 0.8],
        'line-opacity': ['coalesce', ['get', 'strokeOpacity'], 0.17],
      },
    });

    // Hover highlight layers driven by feature-state
    map.addLayer({
      id: HOVER_FILL,
      type: 'fill',
      source: SOURCE,
      paint: {
        'fill-color': ['coalesce', ['get', 'fillColor'], '#243155'],
        'fill-opacity': [
          'case',
          ['boolean', ['feature-state', 'hover'], false],
          ['min', ['+', ['coalesce', ['get', 'fillOpacity'], 0.08], 0.16], 0.85],
          0,
        ],
      },
    });

    map.addLayer({
      id: HOVER_LINE,
      type: 'line',
      source: SOURCE,
      paint: {
        'line-color': '#f0d8a8',
        'line-width': 1.8,
        'line-opacity': ['case', ['boolean', ['feature-state', 'hover'], false], 1, 0],
      },
    });

    map.on('mousemove', FILL_LAYER, (e) => {
      if (!e.features.length) return;

      map.getCanvas().style.cursor = 'pointer';
      const feature = e.features[0];
      const id = feature.id;

      if (hoveredId !== null && hoveredId !== id) {
        map.setFeatureState({ source: SOURCE, id: hoveredId }, { hover: false });
      }
      hoveredId = id;
      map.setFeatureState({ source: SOURCE, id: id }, { hover: true });

      if (_getPopupHtml && feature.properties) {
        const areaKey = getFeatureAreaKey(feature.properties);
        const html = _getPopupHtml(areaKey);
        if (html) {
          if (!popup) {
            popup = new maplibregl.Popup({
              closeButton: false,
              closeOnClick: false,
              maxWidth: '320px',
              className: 'audit-popup',
              offset: 12,
            });
          }
          popup.setLngLat(e.lngLat).setHTML(html).addTo(map);
        }
      }
    });

    map.on('mouseleave', FILL_LAYER, () => {
      map.getCanvas().style.cursor = '';
      clearHover();
    });

    map.on('click', FILL_LAYER, (e) => {
      if (!e.features.length) return;
      const areaKey = getFeatureAreaKey(e.features[0].properties);
      if (_onAreaClick) _onAreaClick(areaKey);
    });
  }

  function render(container, geo, options, onReady) {
    _isProvinceView = options.isProvinceView;
    _onAreaClick = options.onAreaClick;
    _getPopupHtml = options.getPopupHtml;

    ensureMap(container);

    const apply = () => {
      if (!map.getSource(SOURCE)) {
        addLayers();
      }

      clearHover();

      const styledGeo = buildStyledGeo(geo, options.getFeatureStyle);
      map.getSource(SOURCE).setData(styledGeo);

      if (options.fitBounds) {
        const bounds = computeBounds(geo);
        if (bounds) {
          map.fitBounds(bounds, {
            padding: options.isProvinceView ? 80 : 50,
            duration: 300,
          });
        }
      }

      if (onReady) onReady();
    };

    if (map.isStyleLoaded()) {
      apply();
    } else {
      map.once('load', apply);
    }
  }

  function refresh(geo, getFeatureStyle) {
    if (!map?.getSource(SOURCE)) return;
    clearHover();
    map.getSource(SOURCE).setData(buildStyledGeo(geo, getFeatureStyle));
  }

  const FOCUS_SOURCE = 'focus-zone';
  const FOCUS_FILL_LAYER = 'focus-zone-fill';
  const FOCUS_LINE_LAYER = 'focus-zone-line';

  function ensureFocusLayers() {
    if (map.getSource(FOCUS_SOURCE)) return;
    map.addSource(FOCUS_SOURCE, {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
    });
    // Subtle glow fill
    map.addLayer({
      id: FOCUS_FILL_LAYER,
      type: 'fill',
      source: FOCUS_SOURCE,
      paint: {
        'fill-color': '#e8315a',
        'fill-opacity': 0.12,
      },
    });
    // Bold animated-like border
    map.addLayer({
      id: FOCUS_LINE_LAYER,
      type: 'line',
      source: FOCUS_SOURCE,
      paint: {
        'line-color': '#e8315a',
        'line-width': 2.8,
        'line-opacity': 0.9,
        'line-dasharray': [2, 1],
      },
    });
  }

  function setFocusZone(geoFeatures) {
    if (!map) return;
    const applyZone = () => {
      ensureFocusLayers();
      map.getSource(FOCUS_SOURCE).setData({
        type: 'FeatureCollection',
        features: geoFeatures,
      });
    };
    if (map.isStyleLoaded()) {
      applyZone();
    } else {
      map.once('load', applyZone);
    }
  }

  function clearFocusZone() {
    if (!map || !map.getSource(FOCUS_SOURCE)) return;
    map.getSource(FOCUS_SOURCE).setData({ type: 'FeatureCollection', features: [] });
  }

  function addFocusMarker(lngLat, title, subtitle, onClickZoom) {
    if (_focusMarker) { _focusMarker.remove(); _focusMarker = null; }
    if (_focusMarkerPopup) { _focusMarkerPopup.remove(); _focusMarkerPopup = null; }
    if (!map) return;

    // Wrapper: posisi stabil, tidak pernah di-transform
    const el = document.createElement('div');
    el.style.cssText = [
      'width:34px',
      'height:40px',
      'cursor:pointer',
      'position:relative',
    ].join(';');

    // Inner pin: rotate + scale di sini agar tidak geser anchor
    const pin = document.createElement('div');
    pin.style.cssText = [
      'width:26px',
      'height:26px',
      'border-radius:50% 50% 50% 0',
      'background:#e8315a',
      'border:3px solid #fff',
      'box-shadow:0 2px 8px rgba(0,0,0,.55)',
      'transform:rotate(-45deg)',
      'transform-origin:center center',
      'transition:transform .15s, box-shadow .15s',
      'position:absolute',
      'top:0',
      'left:4px',
    ].join(';');

    el.appendChild(pin);

    el.addEventListener('mouseenter', () => {
      pin.style.transform = 'rotate(-45deg) scale(1.2)';
      pin.style.boxShadow = '0 4px 14px rgba(232,49,90,.6)';
    });
    el.addEventListener('mouseleave', () => {
      pin.style.transform = 'rotate(-45deg) scale(1)';
      pin.style.boxShadow = '0 2px 8px rgba(0,0,0,.55)';
    });

    _focusMarker = new maplibregl.Marker({ element: el, anchor: 'top' })
      .setLngLat(lngLat)
      .addTo(map);

    _focusMarkerPopup = new maplibregl.Popup({
      closeButton: true,
      closeOnClick: false,
      maxWidth: '220px',
      className: 'audit-popup focus-popup',
      offset: [0, -32],
    })
      .setLngLat(lngLat)
      .setHTML(
        '<div style="font-weight:700;font-size:13px;color:#111;margin-bottom:3px">' + title + '</div>' +
        '<div style="font-size:11px;color:#555;margin-bottom:6px">' + (subtitle || '') + '</div>' +
        '<div style="font-size:10px;color:#e8315a;cursor:pointer;font-weight:600;padding:4px 0" id="focusZoomBtn">&#128269; Zoom ke wilayah ini</div>'
      )
      .addTo(map);

    // Bind zoom button — gunakan setTimeout agar DOM popup sudah rendered
    if (onClickZoom) {
      setTimeout(() => {
        const btn = document.getElementById('focusZoomBtn');
        if (btn) {
          btn.addEventListener('click', (e) => {
            e.stopPropagation();
            onClickZoom();
          });
        }
      }, 50);
    }

    // Setiap kali popup dibuka ulang, re-bind tombolnya
    _focusMarkerPopup.on('open', () => {
      setTimeout(() => {
        const btn = document.getElementById('focusZoomBtn');
        if (btn && onClickZoom) {
          // Hapus listener lama dulu supaya tidak double
          const newBtn = btn.cloneNode(true);
          btn.parentNode.replaceChild(newBtn, btn);
          newBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            onClickZoom();
          });
        }
      }, 50);
    });

    // Klik pin marker juga langsung zoom
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      if (onClickZoom) onClickZoom();
    });
  }

  function zoomToFeatures(features, padding) {
    if (!map || !features.length) return;
    const geo = { type: 'FeatureCollection', features };
    const bounds = computeBounds(geo);
    if (bounds) {
      map.fitBounds(bounds, { padding: padding || 60, duration: 700 });
    }
  }

  function flyToBandungFallback() {
    if (!map) return;
    map.flyTo({ center: [107.5732, -7.0397], zoom: 11, duration: 700 });
  }

  return { render, refresh, closePopup: clearHover, addFocusMarker, setFocusZone, clearFocusZone, zoomToFeatures, flyToBandungFallback };
})();

export {};
