import { settingsStorage } from "settings";
import { outbox } from "file-transfer";
import * as messaging from "messaging";
import { geolocation } from "geolocation";

/* ---------------- GEOLOCATION & WEATHER ---------------- */
function getLocation() {
  return new Promise((resolve, reject) => {
    geolocation.getCurrentPosition(
      (position) => { resolve(position.coords); },
      (err) => { reject(err); },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 }
    );
  });
}

async function fetchWeather() {
  try {
    const coords = await getLocation();
    const lat = coords.latitude;
    const lon = coords.longitude;



    const response = await fetch(
      `https://api.weatherapi.com/v1/current.json?key=4751ce569a7747d1a66162451262605&q=${lat},${lon}`
    );

    const data = await response.json();
    const tempF = Math.round(data.current.temp_f);
    const tempC = Math.round(data.current.temp_c);
    const is_day = data.current.is_day;
    const condition = data.current.condition.text;
    const wind = Math.round(data.current.wind_mph);

    if (messaging.peerSocket.readyState === messaging.peerSocket.OPEN) {
      messaging.peerSocket.send({
        type: "weather",
        condition,
        wind,
        is_day
      });

      messaging.peerSocket.send({
        type: "temp",
        tempF,
        tempC
      });

    } else {
      console.log("Socket not open!");
    }
  } catch (err) {
    console.log("Weather error:", err);
  }
}

/* ---------------- MESSAGING SOCKET LIFECYCLE ---------------- */
messaging.peerSocket.onopen = () => {
  console.log("Socket open");
  fetchWeather();

  setInterval(() => {
    fetchWeather();
  }, 1000 * 60 * 5);

  geolocation.watchPosition(() => {

    fetchWeather();
  }, (err) => {
    console.log(err);
  }, {
    enableHighAccuracy: true,
    maximumAge: 0,
    timeout: Infinity
  });

  // STARTUP SETTINGS SYNC
  let clockMode = "24hour";
  try {
    const rawClock = settingsStorage.getItem("clockMode");
    if (rawClock) {
      const parsed = JSON.parse(rawClock);
      if (parsed.values && parsed.values[0]) {
        clockMode = parsed.values[0].value;
      }
    }
  } catch (e) { console.log("Clock mode load failed"); }

  let showDate = false;
  try { showDate = settingsStorage.getItem("date") === "true"; } catch (e) {}

  let showSeconds = false;
  try { showSeconds = settingsStorage.getItem("second") === "true"; } catch (e) {}

  let celcius = false;
  try {
    const rawC = settingsStorage.getItem("c");
    if (rawC !== null) celcius = rawC === "true";
  } catch (e) {}

  let km = false;
  try {
    const rawK = settingsStorage.getItem("km");
    if (rawK !== null) km = rawK === "true";
  } catch (e) {}

  console.log("Startup sync:", clockMode, showDate, showSeconds, celcius, km);
  
  messaging.peerSocket.send({
    clockMode: clockMode,
    date: showDate,
    seconds: showSeconds,
    c: celcius,
    km: km
  });
};

function sendMessage(text) {
  if (messaging.peerSocket.readyState === messaging.peerSocket.OPEN) {
    messaging.peerSocket.send(text);
  }
}

/* ---------------- SETTINGS PARSERS ---------------- */
function normalizeInterval(value) {
  if (!value) return 5;
  if (typeof value === "object") value = value.name;
  value = String(value).replace(/[^0-9]/g, "");
  const n = parseInt(value, 10);
  return isNaN(n) ? 5 : n;
}

function extractClockMode(v) {
  if (!v) return null;
  if (typeof v === "string") {
    try { v = JSON.parse(v); } catch { return v; }
  }
  if (v.values && Array.isArray(v.values)) {
    const i = v.selected?.[0];
    if (i != null && v.values[i]) {
      return v.values[i].value ?? v.values[i].name ?? null;
    }
    return v.values[0]?.value ?? null;
  }
  return v.value ?? v.name ?? null;
}

function getInterval() {
  try {
    const raw = settingsStorage.getItem("cycle_interval");
    if (!raw) return 5;
    let parsed = JSON.parse(raw);
    if (parsed.name) parsed = parsed.name;
    if (parsed.values && parsed.values[0]) {
      parsed = parsed.values[0].name || parsed.values[0].value;
    }
    const num = parseInt(parsed, 10);
    return isNaN(num) ? 5 : num;
  } catch (e) {
    console.log("Interval parse failed");
    return 5;
  }
}

/* ---------------- BACKGROUND IMAGE CYCLING ---------------- */
let cycleTimer = null;
let currentIndex = 1;
let cycleStarted = false;

function startCycleLoop(intervalSeconds) {
  if (cycleTimer) clearInterval(cycleTimer);
  cycleTimer = setInterval(() => {
    cycleNextImage();
  },  5000);
}

async function cycleNextImage() {
  // 1. Gather all available image slots currently stored in settings
  let availableSlots = [];
  
  // Assuming a max layout of up to 10 image components in your settings
  for (let i = 1; i <= 10; i++) {
    const slotData = settingsStorage.getItem(`bg_image_${i}`);
    if (slotData) {
      try {
        const parsed = JSON.parse(slotData);
        // Only count it if it actually contains image data
        if (parsed && parsed.imageUri) {
          availableSlots.push(i);
        }
      } catch(e) {
        console.log(`Error parsing slot bg_image_${i}`);
      }
    }
  }

  // 2. If no images are found, stop here
  if (availableSlots.length === 0) {
    console.log("No wallpapers found in settings slots.");
    return;
  }

  // 3. Find the next valid slot index from our available slots array
  // If our current index isn't in the list, default to the first available slot
  let targetSlot = availableSlots.find(slot => slot >= currentIndex);
  
  if (!targetSlot) {
    // We reached the end of our slots, loop back to the first available one
    targetSlot = availableSlots[0];
  }

  // 4. Fetch data and send it
  const imageRawData = settingsStorage.getItem(`bg_image_${targetSlot}`);
  if (imageRawData) {
    console.log(`Cycling successfully to image slot #${targetSlot}`);
    await sendImageToWatch(imageRawData);
  }

  // 5. Progress the pointer past our target slot for the next turn
  currentIndex = targetSlot + 1;
}

async function uploadToCloudinary(base64Image) {
  const cloudName = "dtyw8x96r";
  const uploadPreset = "fitbit";
  const url = `https://api.cloudinary.com/v1_1/${cloudName}/image/upload`;

  const formData = new FormData();

  formData.append("file", `data:image/png;base64,${base64Image}`);
  formData.append("upload_preset", uploadPreset);

  const res = await fetch(url, {
    method: "POST",
    body: formData
  });

  const data = await res.json();

  console.log("Cloudinary URL:", data.secure_url);

  return data.secure_url;
}
async function sendImageToWatch(rawSettingValue) {
  try {
    if (!rawSettingValue) return;

    const imageData = JSON.parse(rawSettingValue);
    if (!imageData.imageUri) return;

    const uri = imageData.imageUri;
    if (!uri.startsWith("data:image")) return;

    const base64 = uri.split(",")[1];
    if (!base64) return;

    console.log("Uploading to Cloudinary...");
    const imageUrl = await uploadToCloudinary(base64);
    console.log("Cloudinary original URL:", imageUrl);

    // --- TRANSFORMATION STEP ---
    // Modify the URL to inject dimensions matching your watch screen.
    // Example: For Versa 3/Sense, use 300. For Versa 4/Sense 2, use 336.
    // f_jpg forces Cloudinary to output a lightweight JPEG that the watch can render.
const optimizedUrl = imageUrl.replace(
  "/upload/",
  "/upload/w_240,h_240,c_fill,q_45,f_jpg,fl_progressive:none/"
);
    console.log("Optimized Delivery URL:", optimizedUrl);

    // Download the optimized asset array buffer on the companion side
// Download the optimized asset array buffer on the companion side
    console.log("Companion downloading optimized hardware asset...");
    const res = await fetch(optimizedUrl);
    const blob = await res.blob();
console.log("Converting blob to arrayBuffer...");
const buffer = await blob.arrayBuffer();
console.log("ArrayBuffer conversion complete.");
    // Stream the binary straight to the watch inbox
    console.log("Streaming binary image directly to watch outbox...");
    console.log("Blob size:", blob.size);
    outbox.enqueue("bg.png", buffer)
      .then((ft) => {
        console.log(`Image transfer queued successfully! Job ID: ${ft.id}`);
      })
      .catch((err) => {
        console.log(`Failed to queue file transfer: ${err}`);
      });

    // CRITICAL FIX: Ensure there is absolutely NO peerSocket.send() for wallpapers here!

  } catch (e) {
    console.log("Send error:", e);
  }
}
/* ---------------- SETTINGS LISTENER ---------------- */
settingsStorage.addEventListener("change", (evt) => {
  if (evt.key === "clockMode") {
    const mode = extractClockMode(evt.newValue);
    console.log("Clock mode:", mode);
    sendMessage(mode);
  }
  if (evt.key === "km") {
    sendMessage(`km ${evt.newValue}`);
  }
  if (evt.key === "date") {
    sendMessage(`date ${evt.newValue}`);
  }
  if (evt.key === "c") {
    sendMessage(`c ${evt.newValue}`);
  }
  if (evt.key === "second") {
    sendMessage(`seconds ${evt.newValue}`);
  }
  if (evt.key === "cycle_interval") {
    const seconds = normalizeInterval(evt.newValue);
    console.log("Interval updated to:", seconds);
    startCycleLoop(seconds);
  }
  if (evt.key.startsWith("bg_image_")) {
    console.log(`User updated slot: ${evt.key}. Transferring...`);
    sendImageToWatch(evt.newValue);
  }
});

/* ---------------- INITIALIZATION SCRIPT RUNS LAST ---------------- */
function initCycle() {
  if (cycleStarted) return;
  cycleStarted = true;
  const interval = getInterval();
  startCycleLoop(interval);
}

// Fire initial setup loops safely
let myKeyValue = settingsStorage.getItem("clockMode");
console.log("Current ClockMode Setting:", myKeyValue);
const currentMode = extractClockMode(myKeyValue);
sendMessage(currentMode);

initCycle();
