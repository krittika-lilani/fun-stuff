"use client";

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";

type City = "chennai" | "calcutta";

type Flight = {
  id: string;
  callsign: string;
  registration: string;
  aircraftType: string;
  altitudeFeet: number | null;
  groundSpeedKnots: number;
  trackDegrees: number;
  latitude: number;
  longitude: number;
  positionTime: number;
  distanceKm: number;
};

type RawAircraft = Record<string, unknown>;

const LOCATIONS = {
  chennai: {
    label: "Chennai",
    shortLabel: "Chn",
    latitude: 13.084346,
    longitude: 80.227325,
    coordinates: "13.084346, 80.227325",
  },
  calcutta: {
    label: "Calcutta",
    shortLabel: "Cal",
    latitude: 22.525298,
    longitude: 88.361538,
    coordinates: "22.525298, 88.361538",
  },
} as const;

const REFRESH_INTERVAL_MS = 10_000;
const DEFAULT_RADIUS_KM = 37.04;

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function distanceKm(lat1: number, lon1: number, lat2: number, lon2: number) {
  const toRadians = (value: number) => (value * Math.PI) / 180;
  const deltaLatitude = toRadians(lat2 - lat1);
  const deltaLongitude = toRadians(lon2 - lon1);
  const a =
    Math.sin(deltaLatitude / 2) ** 2 +
    Math.cos(toRadians(lat1)) *
      Math.cos(toRadians(lat2)) *
      Math.sin(deltaLongitude / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function predictPosition(flight: Flight, now: number) {
  const elapsedSeconds = clamp((now - flight.positionTime) / 1000, 0, 30);
  const distanceKm = flight.groundSpeedKnots * 1.852 * (elapsedSeconds / 3600);
  const bearing = (flight.trackDegrees * Math.PI) / 180;
  const latitude = flight.latitude + (distanceKm * Math.cos(bearing)) / 111.32;
  const longitude =
    flight.longitude +
    (distanceKm * Math.sin(bearing)) /
      (111.32 * Math.cos((flight.latitude * Math.PI) / 180));
  return { latitude, longitude };
}

function positionOnRadar(flight: Flight, city: City, now: number, radiusKm: number) {
  const center = LOCATIONS[city];
  const position = predictPosition(flight, now);
  const northKm = (position.latitude - center.latitude) * 111.32;
  const eastKm =
    (position.longitude - center.longitude) *
    111.32 *
    Math.cos((center.latitude * Math.PI) / 180);
  return {
    x: clamp(50 + (eastKm / radiusKm) * 44, 5, 95),
    y: clamp(50 - (northKm / radiusKm) * 44, 6, 94),
    distanceKm: Math.hypot(northKm, eastKm),
  };
}

function formatAltitude(value: number | null) {
  return value === null ? "altitude unavailable" : `${value.toLocaleString("en-IN")} ft`;
}

export default function Home() {
  const [city, setCity] = useState<City>("chennai");
  const [flights, setFlights] = useState<Flight[]>([]);
  const [radiusKm, setRadiusKm] = useState(DEFAULT_RADIUS_KM);
  const [now, setNow] = useState(() => Date.now());
  const [status, setStatus] = useState<"loading" | "live" | "error">("loading");
  const [message, setMessage] = useState("Looking for nearby aircraft…");

  const fetchFlights = useCallback(async (selectedCity: City, signal?: AbortSignal) => {
    try {
      const location = LOCATIONS[selectedCity];
      const response = await fetch(
        `https://api.airplanes.live/v2/point/${location.latitude}/${location.longitude}/20`,
        {
        cache: "no-store",
        signal,
        },
      );
      if (!response.ok) throw new Error("Live feed unavailable");
      const data = await response.json() as { ac?: RawAircraft[] };
      const timestamp = Date.now();
      const nextFlights = (data.ac ?? [])
        .filter((aircraft) =>
          typeof aircraft.lat === "number" &&
          typeof aircraft.lon === "number" &&
          aircraft.alt_baro !== "ground" &&
          (typeof aircraft.seen_pos !== "number" || aircraft.seen_pos < 60),
        )
        .map((aircraft) => {
          const latitude = aircraft.lat as number;
          const longitude = aircraft.lon as number;
          const seenSeconds = typeof aircraft.seen_pos === "number" ? aircraft.seen_pos : 0;
          return {
            id: String(aircraft.hex ?? `${latitude}-${longitude}`),
            callsign: String(aircraft.flight ?? aircraft.r ?? aircraft.hex ?? "Aircraft").trim(),
            registration: typeof aircraft.r === "string" ? aircraft.r.trim() : "Live ADS-B",
            aircraftType: typeof aircraft.t === "string" ? aircraft.t.trim() : "Aircraft",
            altitudeFeet: typeof aircraft.alt_baro === "number" ? Math.round(aircraft.alt_baro) : null,
            groundSpeedKnots: typeof aircraft.gs === "number" ? aircraft.gs : 0,
            trackDegrees: typeof aircraft.track === "number" ? aircraft.track : 0,
            latitude,
            longitude,
            positionTime: timestamp - seenSeconds * 1000,
            distanceKm: distanceKm(location.latitude, location.longitude, latitude, longitude),
          } satisfies Flight;
        })
        .sort((a, b) => a.distanceKm - b.distanceKm)
        .slice(0, 8);

      setFlights(nextFlights);
      setRadiusKm(DEFAULT_RADIUS_KM);
      setStatus("live");
      setMessage(
        nextFlights.length === 0
          ? "No aircraft within 37 km right now"
          : `${nextFlights.length} aircraft nearby`,
      );
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setStatus("error");
      setMessage("Live aircraft data is temporarily unavailable");
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setFlights([]);
    setStatus("loading");
    setMessage("Looking for nearby aircraft…");
    fetchFlights(city, controller.signal);
    const refresh = window.setInterval(() => fetchFlights(city), REFRESH_INTERVAL_MS);
    return () => {
      controller.abort();
      window.clearInterval(refresh);
    };
  }, [city, fetchFlights]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const time = useMemo(
    () =>
      new Intl.DateTimeFormat("en-GB", {
        timeZone: "Asia/Kolkata",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      }).format(now),
    [now],
  );

  const plottedFlights = useMemo(
    () =>
      flights.map((flight) => ({
        flight,
        ...positionOnRadar(flight, city, now, radiusKm),
      })),
    [flights, city, now, radiusKm],
  );

  return (
    <main className="radar" aria-labelledby="app-title">
      <h1 className="sr-only" id="app-title">Flights over Dibbo</h1>

      <header className="topbar">
        <div className="location-toggle" data-selected={city} role="group" aria-label="Choose Dibbo's location">
          {(Object.keys(LOCATIONS) as City[]).map((key) => (
            <button
              className={`location-option ${city === key ? "is-active" : ""}`}
              type="button"
              key={key}
              aria-pressed={city === key}
              onClick={() => setCity(key)}
            >
              {LOCATIONS[key].shortLabel}
            </button>
          ))}
          <span className="toggle-glider" aria-hidden="true" />
        </div>
      </header>

      <section className="airspace" aria-live="polite" aria-label={`Live flights near ${LOCATIONS[city].label}`}>
        {plottedFlights.map(({ flight, x, y, distanceKm }) => {
          const style = {
            left: `${x}%`,
            top: `${y}%`,
            "--heading": `${flight.trackDegrees - 90}deg`,
          } as CSSProperties;
          return (
            <article
              className={`flight ${x > 68 ? "flight--label-left" : ""}`}
              key={flight.id}
              style={style}
            >
              <span className="flight-motion" aria-hidden="true">
                <span className="flight-trail" />
                <span className="plane">✈</span>
              </span>
              <span className="flight-info">
                <strong>{flight.callsign}</strong>
                <span>{flight.aircraftType} · {formatAltitude(flight.altitudeFeet)} · {distanceKm.toFixed(1)} km</span>
                <span>{flight.registration}</span>
              </span>
            </article>
          );
        })}

        {flights.length === 0 && (
          <p className={`feed-message feed-message--${status}`}>{message}</p>
        )}
      </section>

      <footer className="dibbo-marker">
        <div className="dibbo-pin" aria-hidden="true"><span /></div>
        <div className="dibbo-label">
          <strong>dibbo</strong>
          <div className="dibbo-meta">
            <span>{LOCATIONS[city].coordinates}</span>
            <span aria-hidden="true">·</span>
            <time dateTime={new Date(now).toISOString()} aria-label={`${time} Indian Standard Time`}>{time}</time>
            <span aria-hidden="true">·</span>
            <span className={`live-state live-state--${status}`}>{status === "live" ? "live" : status}</span>
          </div>
        </div>
        <span className="data-credit">airplanes.live</span>
      </footer>
    </main>
  );
}
