"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";

type City = "chennai" | "calcutta";
type SkyPeriod = "dawn" | "day" | "dusk" | "night";

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
  feedUpdatedAt: number;
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
const RADAR_RADIUS_KM = 100;
const MAX_PREDICTION_MS = 20_000;
const MAX_TRACK_AGE_MS = 60_000;
const MAX_VISIBLE_LABELS = 7;

const SKY_BACKGROUNDS: Record<SkyPeriod, string> = {
  dawn:
    "radial-gradient(circle at 18% 88%, rgba(255, 187, 148, .42), transparent 42%), radial-gradient(circle at 95% 12%, rgba(177, 209, 229, .5), transparent 44%), linear-gradient(165deg, #dbeaf2 0%, #f4e7e1 55%, #fff4e9 100%)",
  day:
    "radial-gradient(circle at 8% 5%, rgba(129, 175, 198, .13), transparent 30%), radial-gradient(circle at 100% 72%, rgba(173, 199, 211, .12), transparent 32%), linear-gradient(150deg, #fff 0%, #fbfcfd 54%, #f5f9fa 100%)",
  dusk:
    "radial-gradient(circle at 8% 90%, rgba(229, 133, 119, .56), transparent 40%), radial-gradient(circle at 95% 36%, rgba(114, 113, 164, .45), transparent 48%), linear-gradient(165deg, #536580 0%, #77738e 48%, #c0847e 100%)",
  night:
    "radial-gradient(circle at 76% 14%, rgba(31, 56, 78, .26), transparent 38%), radial-gradient(circle at 9% 92%, rgba(22, 42, 62, .2), transparent 44%), linear-gradient(165deg, #0b1722 0%, #07111c 56%, #040b13 100%)",
};

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
  const elapsedSeconds = clamp((now - flight.positionTime) / 1000, 0, MAX_PREDICTION_MS / 1000);
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
    x: 50 + (eastKm / radiusKm) * 50,
    y: 50 - (northKm / radiusKm) * 50,
    distanceKm: Math.hypot(northKm, eastKm),
  };
}

function formatAltitude(value: number | null) {
  return value === null ? "altitude unavailable" : `${value.toLocaleString("en-IN")} ft`;
}

function getSkyPeriod(timestamp: number): SkyPeriod {
  const hour = Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Kolkata",
      hour: "2-digit",
      hourCycle: "h23",
    }).format(timestamp),
  );

  if (hour >= 5 && hour < 7) return "dawn";
  if (hour >= 17 && hour < 19) return "dusk";
  if (hour >= 19 || hour < 5) return "night";
  return "day";
}

export default function Home() {
  const [city, setCity] = useState<City>("chennai");
  const [flights, setFlights] = useState<Flight[]>([]);
  const [now, setNow] = useState<number | null>(null);
  const [status, setStatus] = useState<"loading" | "live" | "error">("loading");
  const [message, setMessage] = useState("Looking for nearby aircraft…");
  const [showLoveNote, setShowLoveNote] = useState(false);
  const activeCityRef = useRef<City>("chennai");
  const loveNoteTimerRef = useRef<number | null>(null);

  const fetchFlights = useCallback(async (selectedCity: City, signal?: AbortSignal) => {
    try {
      const location = LOCATIONS[selectedCity];
      const response = await fetch(
        `/api/flights?city=${selectedCity}`,
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
            feedUpdatedAt: timestamp,
            distanceKm: distanceKm(location.latitude, location.longitude, latitude, longitude),
          } satisfies Flight;
        })
        .sort((a, b) => a.distanceKm - b.distanceKm)
        .slice(0, 24);

      if (activeCityRef.current !== selectedCity) return;

      setFlights((currentFlights) => {
        const tracks = new Map(currentFlights.map((flight) => [flight.id, flight]));
        nextFlights.forEach((flight) => tracks.set(flight.id, flight));

        return [...tracks.values()]
          .filter((flight) => {
            const position = positionOnRadar(flight, selectedCity, timestamp, RADAR_RADIUS_KM);
            const trackIsCurrent = timestamp - flight.feedUpdatedAt < MAX_TRACK_AGE_MS;
            const nearVisibleArea =
              position.x > -45 && position.x < 145 && position.y > -45 && position.y < 145;
            return trackIsCurrent && nearVisibleArea;
          })
          .sort((a, b) => a.distanceKm - b.distanceKm);
      });
      setStatus("live");
      setMessage(
        nextFlights.length === 0
          ? `No live aircraft reported within ${RADAR_RADIUS_KM} km`
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
    activeCityRef.current = city;
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
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(
    () => () => {
      if (loveNoteTimerRef.current !== null) window.clearTimeout(loveNoteTimerRef.current);
    },
    [],
  );

  const revealLoveNote = () => {
    setShowLoveNote(true);
    if (loveNoteTimerRef.current !== null) window.clearTimeout(loveNoteTimerRef.current);
    loveNoteTimerRef.current = window.setTimeout(() => setShowLoveNote(false), 4000);
  };

  const time = useMemo(
    () => {
      if (now === null) return "--:--:--";
      return new Intl.DateTimeFormat("en-GB", {
        timeZone: "Asia/Kolkata",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      }).format(now);
    },
    [now],
  );

  const plottedFlights = useMemo(
    () =>
      flights
        .map((flight) => ({
          flight,
          ...positionOnRadar(flight, city, now ?? 0, RADAR_RADIUS_KM),
        }))
        .filter(({ x, y }) => x >= 0 && x <= 100 && y >= 0 && y <= 100),
    [flights, city, now],
  );

  const labelledFlightIds = useMemo(() => {
    type LabelBox = { left: number; right: number; top: number; bottom: number };
    const occupied: LabelBox[] = [];
    const labelled = new Set<string>();

    [...plottedFlights]
      .sort((a, b) => a.distanceKm - b.distanceKm)
      .some(({ flight, x, y }) => {
        const labelOnLeft = x > 64;
        const labelWidth = 31;
        const gap = 2.5;
        const box = {
          left: labelOnLeft ? x - labelWidth - gap : x + gap,
          right: labelOnLeft ? x - gap : x + labelWidth + gap,
          top: y - 2.8,
          bottom: y + 4.8,
        };
        const overlaps = occupied.some(
          (other) =>
            box.left < other.right + 1.5 &&
            box.right > other.left - 1.5 &&
            box.top < other.bottom + 1.2 &&
            box.bottom > other.top - 1.2,
        );

        if (!overlaps) {
          occupied.push(box);
          labelled.add(flight.id);
        }

        return labelled.size >= MAX_VISIBLE_LABELS;
      });

    return labelled;
  }, [plottedFlights]);

  const skyPeriod = useMemo(() => now === null ? "day" : getSkyPeriod(now), [now]);

  return (
    <main
      className={`radar sky--${skyPeriod}`}
      aria-labelledby="app-title"
      data-sky={skyPeriod}
      style={{ background: SKY_BACKGROUNDS[skyPeriod] }}
    >
      <h1 className="sr-only" id="app-title">Flights over Dibbo</h1>

      <header className="topbar">
        <div className="location-toggle" data-selected={city} role="group" aria-label="Choose Dibbo's location">
          {(Object.keys(LOCATIONS) as City[]).map((key) => (
            <button
              className={`location-option ${city === key ? "is-active" : ""}`}
              type="button"
              key={key}
              aria-pressed={city === key}
              onClick={() => {
                activeCityRef.current = key;
                setCity(key);
              }}
            >
              {LOCATIONS[key].shortLabel}
            </button>
          ))}
          <span className="toggle-glider" aria-hidden="true" />
        </div>
      </header>

      <section className="airspace" aria-live="polite" aria-label={`Live flights near ${LOCATIONS[city].label}`}>
        {plottedFlights.map(({ flight, x, y, distanceKm }) => {
          const labelIsVisible = labelledFlightIds.has(flight.id);
          const style = {
            left: `${x}%`,
            top: `${y}%`,
            "--heading": `${flight.trackDegrees - 90}deg`,
          } as CSSProperties;
          return (
            <article
              className={`flight ${x > 64 ? "flight--label-left" : ""} ${labelIsVisible ? "" : "flight--label-hidden"}`}
              key={flight.id}
              style={style}
              aria-label={`${flight.callsign}, ${flight.aircraftType}, ${formatAltitude(flight.altitudeFeet)}, ${distanceKm.toFixed(1)} kilometres away`}
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

        {plottedFlights.length === 0 && (
          <p className={`feed-message feed-message--${status}`}>
            {status === "live" ? `No live aircraft reported within ${RADAR_RADIUS_KM} km` : message}
          </p>
        )}
      </section>

      <footer className="dibbo-marker">
        {showLoveNote && (
          <span className="love-note" role="status">love you my nerd</span>
        )}
        <div className="dibbo-pin" aria-hidden="true"><span /></div>
        <div className="dibbo-label">
          <strong>dibbo</strong>
          <div className="dibbo-meta">
            <span>{LOCATIONS[city].coordinates}</span>
            <span aria-hidden="true">·</span>
            <time
              dateTime={now === null ? undefined : new Date(now).toISOString()}
              aria-label={now === null ? "Loading Indian Standard Time" : `${time} Indian Standard Time`}
            >
              {time}
            </time>
            <span aria-hidden="true">·</span>
            <span className={`live-state live-state--${status}`}>{status === "live" ? "live" : status}</span>
          </div>
        </div>
        <button
          className="footer-heart"
          type="button"
          aria-label="Reveal a message"
          aria-expanded={showLoveNote}
          title="Made with care"
          onClick={revealLoveNote}
        >
          ♥
        </button>
      </footer>
    </main>
  );
}
