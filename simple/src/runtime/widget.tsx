/** @jsx jsx */
/** @jsxFrag React.Fragment */
import React, { useEffect, useState, useRef } from 'react';
import { jsx } from 'jimu-core';
import { MapViewManager } from 'jimu-arcgis';
import FeatureLayer from '@arcgis/core/layers/FeatureLayer';
import GeoJSONLayer from '@arcgis/core/layers/GeoJSONLayer';
import SimpleRenderer from '@arcgis/core/renderers/SimpleRenderer';
import SimpleLineSymbol from '@arcgis/core/symbols/SimpleLineSymbol';
import SimpleMarkerSymbol from '@arcgis/core/symbols/SimpleMarkerSymbol';
import Graphic from '@arcgis/core/Graphic';
import GraphicsLayer from '@arcgis/core/layers/GraphicsLayer';
import Point from '@arcgis/core/geometry/Point';
import * as webMercatorUtils from '@arcgis/core/geometry/support/webMercatorUtils';
import './style.css';

const FEATURE_SERVICE_URL = 'https://portalgis.gna.gob.ar/server/rest/services/UNIDADES_REGENCINCO/FeatureServer';
const API_BASE = 'https://www.walkerstooltrip.com/api/external_api_service';

interface SectionInfo { mode: string; duration: number; length: number; }
interface MapCoord { lat: number; lon: number; }

const formatDuration = (seconds: number) => {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  if (hrs === 0) return `${mins} min`;
  if (mins === 0) return `${hrs} h`;
  return `${hrs} h ${mins} min`;
};

const translateMode = (mode: string) => {
  if (mode === 'truck') return 'Camión';
  if (mode === 'car') return 'Automóvil';
  return mode;
};

const Widget: React.FC = () => {
  const [isReady, setIsReady] = useState(false);
  const [view, setView] = useState<__esri.MapView | null>(null);
  const [origin, setOrigin] = useState<MapCoord | null>(null);
  const [originName, setOriginName] = useState<string | null>(null);
  const [destination, setDestination] = useState<MapCoord | null>(null);
  const [destinationName, setDestinationName] = useState<string | null>(null);
  const [mode, setMode] = useState<'truck' | 'car'>('truck');
  const [routeLayer, setRouteLayer] = useState<GeoJSONLayer | null>(null);
  const [sectionsInfo, setSectionsInfo] = useState<SectionInfo[]>([]);
  const [totalDuration, setTotalDuration] = useState(0);
  const [totalLength, setTotalLength] = useState(0);
  const clickLayer = useRef(new GraphicsLayer());
  const prevMapId = useRef<string | null>(null);

  // Retardo inicial
  useEffect(() => {
    const timer = setTimeout(() => setIsReady(true), 5000);
    return () => clearTimeout(timer);
  }, []);

  // Inicializar MapView y gestionar cambio de WebMap
  useEffect(() => {
    if (!isReady) return;
    const vm = MapViewManager.getInstance();
    const jimuIds = vm.getAllJimuMapViewIds();
    const jmv = vm.getJimuMapViewById(jimuIds[0]);
    if (!jmv) return;
    const mv = jmv.view as __esri.MapView;

    // Obtener portalItem.id solo si es WebMap
    const webMap = mv.map as __esri.WebMap;
    const currentMapId = webMap.portalItem && webMap.portalItem.id ? webMap.portalItem.id : null;
    if (prevMapId.current && prevMapId.current !== currentMapId) {
      clickLayer.current.removeAll();
    }
    prevMapId.current = currentMapId;

    if (!mv.map.layers.includes(clickLayer.current as any)) {
      mv.map.add(clickLayer.current);
    }

    setView(mv);

    return () => {
      if (mv.map.layers.includes(clickLayer.current as any)) {
        mv.map.remove(clickLayer.current);
      }
      clickLayer.current.removeAll();
    };
  }, [isReady]);

  // Clicks para origen/destino
  useEffect(() => {
    if (!view) return;
    clickLayer.current.removeAll();

    const fl = new FeatureLayer({ url: FEATURE_SERVICE_URL, outFields: ['DENOMINACI'] });
    view.map.layers.forEach(l => {
      if ((l as any).url === FEATURE_SERVICE_URL) {
        view.map.remove(l);
      }
    });
    view.map.add(fl);

    const handle = view.on('click', async ev => {
      if (origin && destination) return;
      const results = await view.hitTest(ev, { include: [fl] });
      let name: string | null = null;
      if (results.results.length) {
        const graphic = (results.results[0] as any).graphic as __esri.Graphic;
        name = graphic.attributes['DENOMINACI'] || null;
      }
      const ptWeb = ev.mapPoint as Point;
      const ptGeo = webMercatorUtils.webMercatorToGeographic(ptWeb) as Point;
      const coords = { lat: ptGeo.latitude, lon: ptGeo.longitude };
      clickLayer.current.add(
        new Graphic({ geometry: ptWeb, symbol: new SimpleMarkerSymbol({ color: origin ? 'red' : 'green', size: '12px' }) })
      );
      if (!origin) {
        setOrigin(coords);
        setOriginName(name);
      } else {
        setDestination(coords);
        setDestinationName(name);
      }
    });

    return () => handle.remove();
  }, [view, origin, destination]);

  // Llamada API y dibujo de ruta
  useEffect(() => {
    if (!view || !origin || !destination) return;
    (async () => {
      const payload = { user: 'Apytec01', pass: 'U$$er.Pass21', resource: 'routes', origin, destination, transportMode: mode };
      const b64 = btoa(JSON.stringify(payload));
      const apiUrl = `${API_BASE}/${b64}`;
      const resp = await fetch(apiUrl);
      if (!resp.ok) return;
      const routeJson = await resp.json();
      const secs = routeJson.message.routes[0].sections as any[];
      const info = secs.map(s => ({ mode: s.transport?.mode || s.type, duration: s.summary.duration, length: s.summary.length }));
      setSectionsInfo(info);
      setTotalDuration(info.reduce((a, c) => a + c.duration, 0));
      setTotalLength(info.reduce((a, c) => a + c.length, 0));

      if (routeLayer) {
        view.map.remove(routeLayer);
      }

      const raw = secs[0].polyline.polyline as number[][];
      const coordsArr = raw.map(([lat, lon]) => [lon, lat]);
      const geojson = { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'LineString', coordinates: coordsArr }, properties: {} }] };
      const blob = new Blob([JSON.stringify(geojson)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);

      const gLayer = new GeoJSONLayer({ url, renderer: new SimpleRenderer({ symbol: new SimpleLineSymbol({ color: [0, 68, 136], width: 4 }) }) });
      view.map.add(gLayer);
      await gLayer.when();
      view.goTo(gLayer.fullExtent);
      setRouteLayer(gLayer);
    })();
  }, [view, origin, destination, mode]);

  const reset = () => {
    clickLayer.current.removeAll();
    if (routeLayer && view) {
      view.map.remove(routeLayer);
    }
    setOrigin(null);
    setOriginName(null);
    setDestination(null);
    setDestinationName(null);
    setRouteLayer(null);
    setSectionsInfo([]);
    setTotalDuration(0);
    setTotalLength(0);
  };

  return (
    <div className="gov-container">
      <header className="gov-header"><h2>Información de Ruta</h2></header>
      <div className="gov-controls">
        <button onClick={reset}>Reiniciar búsqueda</button>
        <label>
          Transporte:
          <select value={mode} onChange={e => setMode(e.target.value as 'truck' | 'car')}>
            <option value="truck">Camión</option>
            <option value="car">Automóvil</option>
          </select>
        </label>
      </div>
      <div className="gov-instructions">
        {!origin && <p>Click para origen.</p>}
        {origin && !destination && <p>Click para destino.</p>}
      </div>
      <div className="gov-status">
        {!origin || !destination
          ? <span className="gov-wait">Seleccione dos puntos…</span>
          : routeLayer
            ? <span className="gov-success">Ruta ({translateMode(mode)}) lista</span>
            : <span className="gov-loading">Procesando…</span>
        }
        {origin && <p><strong>Origen:</strong> {originName || `${origin.lat.toFixed(6)}, ${origin.lon.toFixed(6)}`}</p>}
        {destination && <p><strong>Destino:</strong> {destinationName || `${destination.lat.toFixed(6)}, ${destination.lon.toFixed(6)}`}</p>}
      </div>
      {routeLayer && (
        <div className="gov-details">
          <p><strong>Duración total:</strong> {formatDuration(totalDuration)}</p>
          <p><strong>Distancia total:</strong> {(totalLength / 1000).toFixed(2)} km</p>
          <table className="gov-table">
            <thead>
              <tr><th>Modo</th><th>Duración</th><th>Distancia</th></tr>
            </thead>
            <tbody>
              {sectionsInfo.map((s, i) => (
                <tr key={i}>
                  <td>{translateMode(s.mode)}</td>
                  <td>{formatDuration(s.duration)}</td>
                  <td>{(s.length / 1000).toFixed(2)} km</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

export default Widget;
