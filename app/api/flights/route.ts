type City = "chennai" | "calcutta";
type Aircraft = Record<string, unknown>;

const LOCATIONS = {
  chennai: { latitude: 13.084346, longitude: 80.227325 },
  calcutta: { latitude: 22.525298, longitude: 88.361538 },
} as const;

const SEARCH_RADIUS_NM = 100;
const RADAR_RADIUS_KM = 100;
const KILOMETRES_PER_NAUTICAL_MILE = 1.852;
const KILOMETRES_PER_LATITUDE_DEGREE = 111.32;
const METRES_PER_SECOND_TO_KNOTS = 1.943844;
const METRES_TO_FEET = 3.28084;

function isUsableAirplanesLiveAircraft(aircraft: Aircraft) {
  return (
    typeof aircraft.lat === "number" &&
    typeof aircraft.lon === "number" &&
    aircraft.alt_baro !== "ground" &&
    (typeof aircraft.seen_pos !== "number" || aircraft.seen_pos < 60)
  );
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

function isInsideVisibleRadar(aircraft: Aircraft, city: City) {
  if (typeof aircraft.lat !== "number" || typeof aircraft.lon !== "number") return false;
  const location = LOCATIONS[city];
  return (
    distanceKm(location.latitude, location.longitude, aircraft.lat, aircraft.lon) <=
    RADAR_RADIUS_KM
  );
}

function openSkyBounds(latitude: number, longitude: number) {
  const radiusKm = SEARCH_RADIUS_NM * KILOMETRES_PER_NAUTICAL_MILE;
  const latitudeDelta = radiusKm / KILOMETRES_PER_LATITUDE_DEGREE;
  const longitudeDelta =
    radiusKm /
    (KILOMETRES_PER_LATITUDE_DEGREE * Math.cos((latitude * Math.PI) / 180));

  return {
    lamin: latitude - latitudeDelta,
    lamax: latitude + latitudeDelta,
    lomin: longitude - longitudeDelta,
    lomax: longitude + longitudeDelta,
  };
}

async function fetchAirplanesLive(city: City, signal: AbortSignal) {
  const location = LOCATIONS[city];
  const response = await fetch(
    `https://api.airplanes.live/v2/point/${location.latitude}/${location.longitude}/${SEARCH_RADIUS_NM}`,
    { cache: "no-store", signal },
  );
  if (!response.ok) throw new Error(`Airplanes.Live returned ${response.status}`);
  const data = (await response.json()) as { ac?: Aircraft[] };
  return (data.ac ?? []).filter(isUsableAirplanesLiveAircraft);
}

async function fetchOpenSky(city: City, signal: AbortSignal) {
  const location = LOCATIONS[city];
  const bounds = openSkyBounds(location.latitude, location.longitude);
  const query = new URLSearchParams({
    lamin: bounds.lamin.toFixed(6),
    lomin: bounds.lomin.toFixed(6),
    lamax: bounds.lamax.toFixed(6),
    lomax: bounds.lomax.toFixed(6),
  });
  const response = await fetch(`https://opensky-network.org/api/states/all?${query}`, {
    cache: "no-store",
    signal,
  });
  if (!response.ok) throw new Error(`OpenSky returned ${response.status}`);

  const data = (await response.json()) as { time?: number; states?: unknown[][] | null };
  const responseTime = typeof data.time === "number" ? data.time : Date.now() / 1000;

  return (data.states ?? []).flatMap((state) => {
    const hex = state[0];
    const callsign = state[1];
    const timePosition = state[3];
    const longitude = state[5];
    const latitude = state[6];
    const altitudeMetres = state[7];
    const onGround = state[8];
    const velocityMetresPerSecond = state[9];
    const trackDegrees = state[10];

    if (
      typeof hex !== "string" ||
      typeof latitude !== "number" ||
      typeof longitude !== "number" ||
      onGround === true
    ) {
      return [];
    }

    const seenSeconds =
      typeof timePosition === "number" ? Math.max(0, responseTime - timePosition) : 0;
    if (seenSeconds > 20) return [];

    return [{
      hex: hex.toLowerCase(),
      flight: typeof callsign === "string" && callsign.trim() ? callsign.trim() : hex.toUpperCase(),
      r: "OpenSky ADS-B",
      t: "Aircraft",
      alt_baro:
        typeof altitudeMetres === "number" ? Math.round(altitudeMetres * METRES_TO_FEET) : undefined,
      gs:
        typeof velocityMetresPerSecond === "number"
          ? velocityMetresPerSecond * METRES_PER_SECOND_TO_KNOTS
          : 0,
      track: typeof trackDegrees === "number" ? trackDegrees : 0,
      lat: latitude,
      lon: longitude,
      seen_pos: seenSeconds,
    } satisfies Aircraft];
  });
}

export async function GET(request: Request) {
  const cityParam = new URL(request.url).searchParams.get("city");
  if (cityParam !== "chennai" && cityParam !== "calcutta") {
    return Response.json({ error: "Unknown city" }, { status: 400 });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);

  try {
    let primary: Aircraft[] = [];
    let primaryFailed = false;

    try {
      primary = await fetchAirplanesLive(cityParam, controller.signal);
    } catch {
      primaryFailed = true;
    }

    if (primary.some((aircraft) => isInsideVisibleRadar(aircraft, cityParam))) {
      return Response.json(
        { ac: primary, providers: ["airplanes.live"] },
        { headers: { "Cache-Control": "no-store" } },
      );
    }

    try {
      const fallback = await fetchOpenSky(cityParam, controller.signal);
      const combined = new Map<string, Aircraft>();
      primary.forEach((aircraft) => {
        const id = String(aircraft.hex ?? `${aircraft.lat}-${aircraft.lon}`).toLowerCase();
        combined.set(id, aircraft);
      });
      fallback.forEach((aircraft) => {
        const id = String(aircraft.hex ?? `${aircraft.lat}-${aircraft.lon}`).toLowerCase();
        if (!combined.has(id)) combined.set(id, aircraft);
      });

      return Response.json(
        {
          ac: [...combined.values()],
          providers: [
            ...(primary.length > 0 ? ["airplanes.live"] : []),
            ...(fallback.length > 0 ? ["opensky"] : []),
          ],
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    } catch {
      if (primaryFailed) {
        return Response.json({ error: "Live feeds unavailable" }, { status: 502 });
      }
      return Response.json(
        { ac: [], providers: [] },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
  } finally {
    clearTimeout(timeout);
  }
}
