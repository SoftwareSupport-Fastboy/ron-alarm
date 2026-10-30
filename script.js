const SUPABASE_URL = "https://bhdnbreeuzscugtthxkn.supabase.co";
const SUPABASE_KEY = "sb_publishable_rkqfF0jOwcGTUoptIo7Djg_2f7EIn0S";

// Bỏ chữ 'const' để gán đè instance trực tiếp vào biến supabase có sẵn:
supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

const STORAGE_KEY = "ron_alarms_cache_v1";
const ORDER_STORAGE_KEY = "ron_alarms_custom_order_v1";

let alarmsList = [];
let editingAlarmId = null;
let currentRecurrence = null;
let isSyncing = false;
let lastMutationTime = 0;

// Variables for 1-second hold and drag-and-drop
let holdTimer = null;
let isHoldingToDrag = false;
let draggedCard = null;
let dragStartX = 0, dragStartY = 0;
let justFinishedDragging = false;

let tempRecur = {
    interval: 1,
    unit: "week",
    days: [1],
    ends: "never",
    endDate: "2027-01-25",
    occurrences: 13
};

const DEFAULT_EMAILS = "loc_nguyen@fastboy.net, nguyentrongtanloc1993@gmail.com";


let localSnoozeMap = {};

// Đồng bộ danh sách snooze từ máy tính
async function fetchSnoozeList() {
    try {
        const res = await fetch('/api/snooze-list');
        if (res.ok) {
            const data = await res.json();
            if (data && typeof data === 'object') {
                const hadChange = JSON.stringify(localSnoozeMap) !== JSON.stringify(data);
                localSnoozeMap = data;
                localStorage.setItem("ron_snooze_cache", JSON.stringify(data));
                if (hadChange) renderAlarmCards();
                return;
            }
        }
    } catch (e) { }

    try {
        const raw = localStorage.getItem("ron_snooze_cache");
        if (raw) localSnoozeMap = JSON.parse(raw);
    } catch (e) { }
}

// Hàm hủy Snooze khi người dùng bấm vào nút trên thẻ báo thức
async function cancelSnooze(alarmId, event) {
    if (event) event.stopPropagation();

    delete localSnoozeMap[alarmId];
    localStorage.setItem("ron_snooze_cache", JSON.stringify(localSnoozeMap));
    renderAlarmCards();
    showToast("Snooze cancelled!", "info");

    try {
        await fetch('/api/cancel-snooze', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: alarmId })
        });
    } catch (e) {
        console.warn("Lỗi hủy snooze:", e);
    }
}

// Định kỳ quét danh sách snooze mỗi 2 giây
setInterval(fetchSnoozeList, 2000);
/**
 * Chuyển đổi dữ liệu từ Supabase về đúng định dạng frontend đang dùng
 */
function mapFromSupabase(row) {
    return {
        id: row.id,
        alarmTime: row.alarm_time,
        note: row.note || "",
        email: row.target_email || "",
        status: row.status || "PENDING",
        recurrence: typeof row.recurrence === "object" && row.recurrence !== null
            ? JSON.stringify(row.recurrence)
            : (row.recurrence || ""),
        sound: row.sound || "sound/Chimes.wav",
        sort_order: row.sort_order || 0
    };
}

/* ============================================================
   LOCAL STORAGE & DISPLAY ORDER
   ============================================================ */
function getCachedAlarms() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        return raw ? JSON.parse(raw) : [];
    } catch (e) {
        return [];
    }
}

function saveAlarmsToStorage(data) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

function getSavedOrder() {
    try {
        const raw = localStorage.getItem(ORDER_STORAGE_KEY);
        return raw ? JSON.parse(raw) : [];
    } catch (e) {
        return [];
    }
}

function saveSavedOrder(orderIds) {
    localStorage.setItem(ORDER_STORAGE_KEY, JSON.stringify(orderIds));
}

function applyDisplayOrder(list) {
    const savedOrder = getSavedOrder();

    if (savedOrder && savedOrder.length > 0) {
        const orderMap = new Map();
        savedOrder.forEach((id, index) => orderMap.set(id, index));

        return [...list].sort((a, b) => {
            const hasA = orderMap.has(a.id);
            const hasB = orderMap.has(b.id);

            if (hasA && hasB) return orderMap.get(a.id) - orderMap.get(b.id);
            if (hasA && !hasB) return -1;
            if (!hasA && hasB) return 1;
            return 0;
        });
    }

    return [...list];
}

function showToast(message, type = "warning") {
    let toast = document.getElementById("syncToast");
    if (!toast) {
        toast = document.createElement("div");
        toast.id = "syncToast";
        toast.className = "sync-toast";
        document.body.appendChild(toast);
    }

    let icon = "fa-triangle-exclamation";
    if (type === "info") icon = "fa-circle-info";
    if (type === "success") icon = "fa-circle-check";

    toast.innerHTML = `<i class="fa-solid ${icon}"></i> <span>${message}</span>`;
    toast.className = `sync-toast show ${type}`;

    setTimeout(() => {
        toast.classList.remove("show");
    }, 4000);
}

function isAlarmModalOpen() {
    const modal = document.getElementById("alarmModal");
    return modal && modal.style.display === "flex";
}

/* ============================================================
   BACKGROUND SYNC & SERVER DIFF CHECK (SUPABASE)
   ============================================================ */
function isDataDifferent(localAlarms, serverAlarms) {
    if (!Array.isArray(localAlarms) || !Array.isArray(serverAlarms)) return true;
    if (localAlarms.length !== serverAlarms.length) return true;

    for (let i = 0; i < localAlarms.length; i++) {
        if (localAlarms[i].id !== serverAlarms[i].id) return true;
    }

    const localMap = new Map(localAlarms.map(a => [a.id, a]));
    for (const s of serverAlarms) {
        const l = localMap.get(s.id);
        if (!l) return true;
        if (
            l.alarmTime !== s.alarmTime ||
            l.status !== s.status ||
            l.note !== s.note ||
            (l.recurrence || "") !== (s.recurrence || "") ||
            (l.email || "") !== (s.email || "") ||
            (l.sound || "") !== (s.sound || "")
        ) {
            return true;
        }
    }
    return false;
}

async function syncWithBackend() {
    if (!supabase) return;
    if (Date.now() - lastMutationTime < 4000) return;
    if (isHoldingToDrag) return;
    if (isSyncing) return;
    isSyncing = true;

    try {
        const { data, error } = await supabase
            .from("alarms")
            .select("*")
            .order("sort_order", { ascending: true });

        if (error) throw error;
        let serverAlarms = (data || []).map(mapFromSupabase);

        if (Date.now() - lastMutationTime < 4000) return;

        if (isDataDifferent(alarmsList, serverAlarms)) {
            const modalOpen = isAlarmModalOpen();

            if (modalOpen && editingAlarmId !== null) {
                closeModal("alarmModal");
                editingAlarmId = null;
                showToast("Server data updated. Edit modal was closed to sync latest data!", "warning");
            }

            alarmsList = serverAlarms;
            saveSavedOrder(alarmsList.map(a => a.id));
            saveAlarmsToStorage(alarmsList);
            renderAlarmCards();
        }
    } catch (err) {
        console.warn("Background sync error:", err);
    } finally {
        isSyncing = false;
    }
}

async function fetchAlarms() {
    if (!supabase) return;
    showToast("Checking data from server...", "info");
    lastMutationTime = 0;

    try {
        const { data, error } = await supabase
            .from("alarms")
            .select("*")
            .order("sort_order", { ascending: true });

        if (error) throw error;
        const serverAlarms = (data || []).map(mapFromSupabase);

        const hasDiff = isDataDifferent(alarmsList, serverAlarms);

        alarmsList = serverAlarms;
        saveSavedOrder(alarmsList.map(a => a.id));
        saveAlarmsToStorage(alarmsList);
        renderAlarmCards();

        if (hasDiff) {
            showToast("Data updated successfully!", "info");
        } else {
            showToast("Already up to date!", "info");
        }
    } catch (err) {
        console.error("fetchAlarms error:", err);
        showToast("Failed to sync with server. Please try again!", "warning");
    }
}

async function syncReorderToBackend(orderIds) {
    if (!supabase) return;
    lastMutationTime = Date.now();
    try {
        const promises = orderIds.map((id, index) =>
            supabase.from("alarms").update({ sort_order: index + 1 }).eq("id", id)
        );
        await Promise.all(promises);
        showToast("Alarm order saved to server!", "info");
    } catch (e) {
        console.error("Error syncing alarm order to backend:", e);
    }
}

/* ============================================================
   OPTIMISTIC UI MUTATIONS (SUPABASE)
   ============================================================ */
async function handleToggleAlarm(id, enable, currentAlarmTime) {
    lastMutationTime = Date.now();

    const alarm = alarmsList.find(a => a.id === id);
    if (!alarm) return;

    let updatePayload = {};

    if (!enable) {
        alarm.status = "STOPPED";
        updatePayload.status = "STOPPED";
    } else {
        alarm.status = "PENDING";
        updatePayload.status = "PENDING";
        const ctNow = getCentralTimeComponents();
        const [oldDate, timePart] = currentAlarmTime.split(" ");
        let newTargetStr = `${ctNow.dateStr} ${timePart}`;

        if (newTargetStr <= ctNow.fullStr) {
            const tomorrow = new Date();
            tomorrow.setDate(tomorrow.getDate() + 1);
            const tParts = new Intl.DateTimeFormat('en-CA', {
                timeZone: 'America/Chicago',
                year: 'numeric', month: '2-digit', day: '2-digit'
            }).formatToParts(tomorrow);
            const tMap = {};
            tParts.forEach(p => tMap[p.type] = p.value);
            newTargetStr = `${tMap.year}-${tMap.month}-${tMap.day} ${timePart}`;
        }
        alarm.alarmTime = newTargetStr;
        updatePayload.alarm_time = newTargetStr;
    }

    saveAlarmsToStorage(alarmsList);
    renderAlarmCards();

    try {
        const { error } = await supabase
            .from("alarms")
            .update(updatePayload)
            .eq("id", id);
        if (error) console.error("Error updating status:", error);
    } catch (e) {
        console.error("Error sending toggle update:", e);
    }
}

async function deleteAlarm(id) {
    lastMutationTime = Date.now();

    alarmsList = alarmsList.filter(a => a.id !== id);

    const savedOrder = getSavedOrder().filter(savedId => savedId !== id);
    saveSavedOrder(savedOrder);

    saveAlarmsToStorage(alarmsList);
    renderAlarmCards();

    try {
        const { error } = await supabase
            .from("alarms")
            .delete()
            .eq("id", id);
        if (error) console.error("Error deleting alarm:", error);
    } catch (e) {
        console.error("Error deleting alarm:", e);
    }
}

async function saveAlarm() {
    lastMutationTime = Date.now();

    const isSpecificDate = document.getElementById("chkSpecificDate").checked;
    const isRepeat = document.getElementById("chkRepeat").checked;
    let dateVal = document.getElementById("modalDate").value;
    const noteVal = document.getElementById("modalNote").value.trim() || "Alarm";
    const targetEmails = getSavedEmails();
    const soundSelect = document.getElementById("modalSound");
    const soundVal = (soundSelect && soundSelect.value) ? soundSelect.value : "sound/Chimes.wav";

    const ctNow = getCentralTimeComponents();
    if (!isSpecificDate || !dateVal) {
        dateVal = ctNow.dateStr;
    }

    let h24 = currentH;
    if (currentAmPm === "PM" && h24 < 12) h24 += 12;
    if (currentAmPm === "AM" && h24 === 12) h24 = 0;
    const hStr = h24 < 10 ? `0${h24}` : h24;
    const mStr = currentM < 10 ? `0${currentM}` : currentM;

    let finalCentralTime = `${dateVal} ${hStr}:${mStr}`;

    if (!isSpecificDate && finalCentralTime <= ctNow.fullStr) {
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        const tParts = new Intl.DateTimeFormat('en-CA', {
            timeZone: 'America/Chicago',
            year: 'numeric', month: '2-digit', day: '2-digit'
        }).formatToParts(tomorrow);
        const tMap = {};
        tParts.forEach(p => tMap[p.type] = p.value);
        finalCentralTime = `${tMap.year}-${tMap.month}-${tMap.day} ${hStr}:${mStr}`;
    }

    const recurrenceJson = (isRepeat && currentRecurrence && currentRecurrence.enabled)
        ? JSON.stringify(currentRecurrence)
        : "";

    let recurObj = null;
    try {
        if (recurrenceJson) recurObj = JSON.parse(recurrenceJson);
    } catch (e) { }

    let createdId = null;

    if (editingAlarmId) {
        const idx = alarmsList.findIndex(a => a.id === editingAlarmId);
        if (idx !== -1) {
            alarmsList[idx].alarmTime = finalCentralTime;
            alarmsList[idx].note = noteVal;
            alarmsList[idx].status = "PENDING";
            alarmsList[idx].recurrence = recurrenceJson;
            alarmsList[idx].sound = soundVal;
        }
    } else {
        createdId = "ALARM_" + new Date().getTime();
        const newAlarm = {
            id: createdId,
            alarmTime: finalCentralTime,
            note: noteVal,
            email: targetEmails,
            status: "PENDING",
            recurrence: recurrenceJson,
            sound: soundVal
        };

        alarmsList.push(newAlarm);

        const currentSavedOrder = getSavedOrder();
        if (currentSavedOrder.length > 0) {
            currentSavedOrder.push(createdId);
            saveSavedOrder(currentSavedOrder);
        }
    }

    saveAlarmsToStorage(alarmsList);
    renderAlarmCards();

    document.getElementById("modalNote").value = "";
    closeModal('alarmModal');

    try {
        if (editingAlarmId) {
            const { error } = await supabase
                .from("alarms")
                .update({
                    alarm_time: finalCentralTime,
                    note: noteVal,
                    status: "PENDING",
                    recurrence: recurObj,
                    sound: soundVal
                })
                .eq("id", editingAlarmId);
            if (error) console.error("Error updating alarm:", error);
        } else {
            const { error } = await supabase
                .from("alarms")
                .insert([{
                    id: createdId,
                    alarm_time: finalCentralTime,
                    note: noteVal,
                    target_email: targetEmails,
                    status: "PENDING",
                    recurrence: recurObj,
                    sound: soundVal,
                    sort_order: alarmsList.length
                }]);
            if (error) console.error("Error creating alarm:", error);
        }
    } catch (err) {
        console.error("Error saving alarm to server:", err);
    }
}

/* ============================================================
   SOUND MANAGER & PREVIEW
   ============================================================ */
const SOUND_FILES = [
    "Ascending.wav",
    "Bounce.wav",
    "Chimes.wav",
    "Chords.wav",
    "Descending.wav",
    "Echo.wav",
    "Jingle.wav",
    "Tap.wav",
    "Transition.wav",
    "Xylophone.wav"
];

let previewAudio = null;

function initSoundOptions() {
    const soundSelect = document.getElementById("modalSound");
    if (!soundSelect) return;

    soundSelect.innerHTML = "";
    SOUND_FILES.forEach(fileName => {
        const displayName = fileName.replace(/\.wav$/i, "");
        const opt = document.createElement("option");
        opt.value = `sound/${fileName}`;
        opt.innerText = displayName;

        if (displayName === "Chimes") {
            opt.selected = true;
        }

        soundSelect.appendChild(opt);
    });
}

function togglePreviewSound() {
    const soundSelect = document.getElementById("modalSound");
    const btn = document.getElementById("btnPreviewSound");
    if (!soundSelect || !btn) return;

    const soundPath = soundSelect.value;

    if (previewAudio && !previewAudio.paused) {
        stopPreviewSound();
        return;
    }

    if (!soundPath) return;

    if (!previewAudio) {
        previewAudio = new Audio();
        previewAudio.onended = () => stopPreviewSound();
    }

    previewAudio.src = soundPath;
    previewAudio.play().then(() => {
        btn.innerHTML = '<i class="fa-solid fa-stop"></i>';
        btn.classList.add("playing");
        btn.title = "Stop preview";
    }).catch(err => {
        console.warn("Không phát được âm thanh:", err);
        showToast("Cannot play sound preview. Please check file path!", "warning");
        stopPreviewSound();
    });
}

function stopPreviewSound() {
    if (previewAudio) {
        previewAudio.pause();
        previewAudio.currentTime = 0;
    }
    const btn = document.getElementById("btnPreviewSound");
    if (btn) {
        btn.innerHTML = '<i class="fa-solid fa-play"></i>';
        btn.classList.remove("playing");
        btn.title = "Preview sound";
    }
}

function onSoundChange() {
    stopPreviewSound();
}

function initAlarms() {
    alarmsList = applyDisplayOrder(getCachedAlarms());
    if (alarmsList.length > 0) {
        renderAlarmCards();
    } else {
        const container = document.getElementById("cardsContainer");
        container.innerHTML = `<div style="grid-column: 1/-1; color: var(--text-muted); font-size: 14px;">Loading alarms...</div>`;
    }

    syncWithBackend();
    setInterval(syncWithBackend, 5000);
    setupGlobalDragEvents();
}

/* ============================================================
   GENERAL UTILITIES
   ============================================================ */
function getSavedEmails() {
    return localStorage.getItem("alarm_target_emails") || DEFAULT_EMAILS;
}

function openSettingsModal() {
    document.getElementById("settingsEmails").value = getSavedEmails();
    document.getElementById("settingsModal").style.display = "flex";
}

function saveSettings() {
    const val = document.getElementById("settingsEmails").value.trim();
    localStorage.setItem("alarm_target_emails", val);
    closeModal("settingsModal");
    showToast("Notification email settings saved successfully!", "success");
}

function closeModal(id) {
    if (id === 'alarmModal') {
        stopPreviewSound();
    }
    document.getElementById(id).style.display = "none";
}

function setQuickNote(txt) {
    const input = document.getElementById("modalNote");
    if (input) {
        input.value = txt;
        input.focus();
    }
}

function getCentralTimeComponents() {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Chicago',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false
    }).formatToParts(new Date());

    const map = {};
    parts.forEach(p => map[p.type] = p.value);
    return {
        year: map.year,
        month: map.month,
        day: map.day,
        hour: parseInt(map.hour),
        minute: parseInt(map.minute),
        second: parseInt(map.second),
        dateStr: `${map.year}-${map.month}-${map.day}`,
        fullStr: `${map.year}-${map.month}-${map.day} ${map.hour}:${map.minute}`
    };
}

function updateClocks() {
    const now = new Date();

    const options = {
        weekday: 'short',
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        second: '2-digit'
    };

    const ctText = now.toLocaleString("en-US", {
        timeZone: "America/Chicago",
        ...options
    });

    const hcmText = now.toLocaleString("en-US", {
        timeZone: "Asia/Ho_Chi_Minh",
        ...options
    });

    const ctEl = document.getElementById("ctClockText");
    const hcmEl = document.getElementById("hcmClockText");
    if (ctEl) ctEl.innerText = `Central Time: ${ctText}`;
    if (hcmEl) hcmEl.innerText = `HCM Time: ${hcmText}`;
}
setInterval(updateClocks, 1000);
updateClocks();

function switchTab(tab) {
    document.querySelectorAll(".nav-list .nav-item").forEach(item => item.classList.remove("active"));
    if (tab === 'alarm') {
        document.querySelectorAll(".nav-list .nav-item")[1].classList.add("active");
        document.getElementById("alarmView").style.display = "flex";
        document.getElementById("timerView").style.display = "none";
    } else {
        document.querySelectorAll(".nav-list .nav-item")[0].classList.add("active");
        document.getElementById("alarmView").style.display = "none";
        document.getElementById("timerView").style.display = "block";
    }
}

/* ============================================================
   HOLD 1s & DRAG/DROP REORDERING
   ============================================================ */
function setupGlobalDragEvents() {
    window.addEventListener("pointermove", (e) => {
        if (!holdTimer && !isHoldingToDrag) return;

        const moveDistance = Math.hypot(e.clientX - dragStartX, e.clientY - dragStartY);

        if (!isHoldingToDrag) {
            if (moveDistance > 8) {
                clearTimeout(holdTimer);
                holdTimer = null;
            }
            return;
        }

        e.preventDefault();
        const elementBelow = document.elementFromPoint(e.clientX, e.clientY);
        if (!elementBelow) return;

        const targetCard = elementBelow.closest(".alarm-card");
        if (targetCard && targetCard !== draggedCard && targetCard.parentNode === draggedCard.parentNode) {
            const rect = targetCard.getBoundingClientRect();
            const isAfter = (e.clientX > rect.left + rect.width / 2) || (e.clientY > rect.top + rect.height / 2);

            if (isAfter) {
                targetCard.after(draggedCard);
            } else {
                targetCard.before(draggedCard);
            }
        }
    }, { passive: false });

    window.addEventListener("pointerup", () => {
        clearTimeout(holdTimer);
        holdTimer = null;

        if (isHoldingToDrag) {
            isHoldingToDrag = false;
            justFinishedDragging = true;
            document.body.classList.remove("is-reordering-alarms");

            if (draggedCard) {
                draggedCard.classList.remove("is-drag-ready");
                draggedCard = null;
            }

            const newOrderIds = Array.from(document.querySelectorAll("#cardsContainer .alarm-card"))
                .map(card => card.getAttribute("data-id"))
                .filter(Boolean);

            const alarmMap = new Map(alarmsList.map(a => [a.id, a]));
            alarmsList = newOrderIds.map(id => alarmMap.get(id)).filter(Boolean);

            saveSavedOrder(newOrderIds);
            saveAlarmsToStorage(alarmsList);
            syncReorderToBackend(newOrderIds);

            setTimeout(() => {
                justFinishedDragging = false;
            }, 250);
        }
    });

    window.addEventListener("pointercancel", () => {
        clearTimeout(holdTimer);
        holdTimer = null;
        if (draggedCard) {
            draggedCard.classList.remove("is-drag-ready");
            draggedCard = null;
        }
        isHoldingToDrag = false;
        document.body.classList.remove("is-reordering-alarms");
    });
}

/* ============================================================
   RENDER ALARM CARDS
   ============================================================ */
function renderAlarmCards() {
    const container = document.getElementById("cardsContainer");
    container.innerHTML = "";

    if (alarmsList.length === 0) {
        container.innerHTML = `<div style="grid-column: 1/-1; color: var(--text-muted); font-size: 14px;">No alarms yet. Click + to add one.</div>`;
        return;
    }

    const ctNow = getCentralTimeComponents();
    const currentCentralDateObj = new Date(ctNow.fullStr.replace(/-/g, "/"));

    alarmsList.forEach(alarm => {
        const [datePart, timePart] = alarm.alarmTime.split(" ");
        let [h, m] = timePart.split(":").map(Number);
        const ampm = h >= 12 ? "PM" : "AM";
        const displayH = h % 12 || 12;
        const displayM = m < 10 ? `0${m}` : m;

        // 1. Kiểm tra trạng thái Snooze trên máy tính
        const snoozeInfo = localSnoozeMap[alarm.id];
        const isSnoozed = !!(snoozeInfo && snoozeInfo.mins);

        // Nếu đang Snooze thì KHÔNG coi là STOPPED để thẻ luôn sáng như đang bật
        const isStopped = alarm.status === "STOPPED" && !isSnoozed;
        const isChecked = !isStopped;

        let recurrence = null;
        try {
            if (alarm.recurrence) recurrence = JSON.parse(alarm.recurrence);
        } catch (e) { }

        let alarmDateObj = new Date(alarm.alarmTime.replace(/-/g, "/"));

        if (!isStopped) {
            if (recurrence && recurrence.enabled && recurrence.unit === 'week' && recurrence.days && recurrence.days.length > 0) {
                const now = currentCentralDateObj;
                const currentDay = now.getDay();
                let targetDayOffset = -1;

                for (let i = 0; i <= 7; i++) {
                    let checkDay = (currentDay + i) % 7;
                    if (recurrence.days.includes(checkDay)) {
                        if (i === 0) {
                            let testDate = new Date(now);
                            testDate.setHours(h, m, 0, 0);
                            if (testDate > now) {
                                targetDayOffset = i;
                                break;
                            }
                        } else {
                            targetDayOffset = i;
                            break;
                        }
                    }
                }

                if (targetDayOffset !== -1) {
                    alarmDateObj = new Date(currentCentralDateObj);
                    alarmDateObj.setDate(alarmDateObj.getDate() + targetDayOffset);
                    alarmDateObj.setHours(h, m, 0, 0);
                }
            } else {
                if (alarmDateObj <= currentCentralDateObj) {
                    alarmDateObj.setDate(alarmDateObj.getDate() + 1);
                    alarmDateObj.setHours(h, m, 0, 0);
                }
            }
        }

        const diffMs = alarmDateObj - currentCentralDateObj;
        let countdownStr = "";
        let isUnderOneDay = false;

        if (isStopped) {
            countdownStr = "Off";
        } else if (diffMs > 0) {
            const diffMins = Math.floor(diffMs / 60000);
            const days = Math.floor(diffMins / (24 * 60));
            const hours = Math.floor((diffMins % (24 * 60)) / 60);
            const mins = diffMins % 60;

            if (days > 0) {
                countdownStr = `🔔 in ${days} day${days > 1 ? 's' : ''}, ${hours} hours`;
            } else {
                countdownStr = `🔔 in ${hours} hours, ${mins} minutes`;
                isUnderOneDay = true;
            }
        } else {
            countdownStr = "⏰ Time's up";
        }

        const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
        let dayPillsHtml = "";
        if (recurrence && recurrence.enabled) {
            dayPillsHtml = dayNames.map((d, idx) => {
                const isActive = (recurrence.unit === 'week' && recurrence.days.includes(idx)) || recurrence.unit === 'day';
                return `<span class="day-pill ${isActive ? 'active' : ''}">${d}</span>`;
            }).join("");
        } else {
            dayPillsHtml = `<span style="font-size: 11px; color: #777;">Once (${datePart})</span>`;
        }

        // 2. Tùy biến nút toggle: nếu Snooze thì thay bằng nhãn thẻ [Snooze]
        let toggleOrSnoozeHtml = "";
        if (isSnoozed) {
            toggleOrSnoozeHtml = `<span class="snooze-status-pill">Snooze</span>`;
        } else {
            toggleOrSnoozeHtml = `
              <label class="switch">
                <input type="checkbox" ${isChecked ? "checked" : ""} onchange="handleToggleAlarm('${alarm.id}', this.checked, '${alarm.alarmTime}')">
                <span class="slider"></span>
              </label>
            `;
        }

        // 3. Ẩn dòng chữ Off hoặc dòng đếm ngược khi đang Snooze
        let countdownHtml = "";
        if (!isSnoozed) {
            countdownHtml = `<div class="countdown-text ${isUnderOneDay ? 'highlight-soon' : ''}" ${isUnderOneDay ? 'title="under 1 day"' : ''}>${countdownStr}</div>`;
        }

        // 4. Nút bấm hủy Snooze
        let snoozeButtonHtml = "";
        if (isSnoozed) {
            snoozeButtonHtml = `
              <div class="snooze-badge-wrapper" onclick="event.stopPropagation()">
                <button class="btn-cancel-snooze" onclick="cancelSnooze('${alarm.id}', event)" title="Click to cancel snooze">
                  <i class="fa-solid fa-clock-rotate-left"></i> Snooze ${snoozeInfo.mins} minute(s) <span class="cancel-x">✕</span>
                </button>
              </div>
            `;
        }

        const card = document.createElement("div");
        // Thêm class 'is-snoozed' để áp style chữ trắng và loại bỏ class 'is-stopped'
        card.className = `alarm-card ${isStopped ? "is-stopped" : ""} ${isSnoozed ? "is-snoozed" : ""}`;
        card.setAttribute("data-id", alarm.id);

        card.onclick = () => {
            if (justFinishedDragging) return;
            openEditModal(alarm.id);
        };

        card.addEventListener("pointerdown", (e) => {
            if (e.target.closest(".card-actions") || e.target.closest(".btn-delete-card") || e.target.closest(".switch") || e.target.closest(".btn-cancel-snooze")) {
                return;
            }

            dragStartX = e.clientX;
            dragStartY = e.clientY;
            isHoldingToDrag = false;

            holdTimer = setTimeout(() => {
                isHoldingToDrag = true;
                draggedCard = card;
                card.classList.add("is-drag-ready");
                document.body.classList.add("is-reordering-alarms");

                if (navigator.vibrate) navigator.vibrate(50);
            }, 1000);
        });

        card.innerHTML = `
      <div class="card-top">
        <div>
          <span class="time-display">${displayH}:${displayM}</span>
          <span class="time-ampm">${ampm}</span>
        </div>
        <div class="card-actions" onclick="event.stopPropagation()">
          <button class="btn-delete-card" onclick="deleteAlarm('${alarm.id}')" title="Delete alarm">
            <i class="fa-regular fa-trash-can"></i>
          </button>
          ${toggleOrSnoozeHtml}
        </div>
      </div>
      ${countdownHtml}
      ${snoozeButtonHtml}
      <div class="alarm-title">${alarm.note || "Alarm"}</div>
      <div class="days-row">${dayPillsHtml}</div>
    `;
        container.appendChild(card);
    });
}

/* ============================================================
   TIME PICKER
   ============================================================ */
let currentH = 10, currentM = 45, currentAmPm = "PM";
let hourBuffer = "", hourTimer = null;
let minBuffer = "", minTimer = null;

function updateWheelDisplay() {
    document.getElementById("pickHour").innerText = currentH < 10 ? `0${currentH}` : currentH;
    document.getElementById("pickMinute").innerText = currentM < 10 ? `0${currentM}` : currentM;
    document.getElementById("pickAmPm").innerText = currentAmPm;
}

function stepHour(step) {
    currentH = ((currentH - 1 + step + 12) % 12) + 1;
    updateWheelDisplay();
}

function stepMinute(step) {
    currentM = (currentM + step + 60) % 60;
    updateWheelDisplay();
}

function toggleAmPm() {
    currentAmPm = currentAmPm === "AM" ? "PM" : "AM";
    updateWheelDisplay();
}

function setupTimePickerEvents() {
    const hourEl = document.getElementById("pickHour");
    const minEl = document.getElementById("pickMinute");
    const ampmEl = document.getElementById("pickAmPm");
    if (!hourEl || !minEl || !ampmEl) return;

    hourEl.addEventListener("keydown", (e) => {
        if (e.key >= '0' && e.key <= '9') {
            e.preventDefault();
            clearTimeout(hourTimer);
            hourBuffer += e.key;
            let val = parseInt(hourBuffer, 10);

            if (hourBuffer.length === 1) {
                if (val === 0) currentH = 12;
                else if (val >= 2) {
                    currentH = val;
                    hourBuffer = "";
                    updateWheelDisplay();
                    minEl.focus();
                    return;
                } else {
                    currentH = 1;
                }
            } else if (hourBuffer.length >= 2) {
                currentH = (val >= 1 && val <= 12) ? val : (parseInt(e.key, 10) || 12);
                hourBuffer = "";
                updateWheelDisplay();
                minEl.focus();
                return;
            }
            updateWheelDisplay();
            hourTimer = setTimeout(() => { hourBuffer = ""; }, 1200);
        } else if (e.key === "ArrowUp") {
            e.preventDefault();
            stepHour(1);
        } else if (e.key === "ArrowDown") {
            e.preventDefault();
            stepHour(-1);
        } else if (e.key === "ArrowRight") {
            e.preventDefault();
            minEl.focus();
        }
    });

    minEl.addEventListener("keydown", (e) => {
        if (e.key >= '0' && e.key <= '9') {
            e.preventDefault();
            clearTimeout(minTimer);
            minBuffer += e.key;
            let val = parseInt(minBuffer, 10);

            if (minBuffer.length === 1) {
                if (val >= 6) {
                    currentM = val;
                    minBuffer = "";
                    updateWheelDisplay();
                    ampmEl.focus();
                    return;
                } else {
                    currentM = val;
                }
            } else if (minBuffer.length >= 2) {
                currentM = (val >= 0 && val <= 59) ? val : parseInt(e.key, 10);
                minBuffer = "";
                updateWheelDisplay();
                ampmEl.focus();
                return;
            }
            updateWheelDisplay();
            minTimer = setTimeout(() => { minBuffer = ""; }, 1200);
        } else if (e.key === "ArrowUp") {
            e.preventDefault();
            stepMinute(1);
        } else if (e.key === "ArrowDown") {
            e.preventDefault();
            stepMinute(-1);
        } else if (e.key === "ArrowLeft") {
            e.preventDefault();
            hourEl.focus();
        } else if (e.key === "ArrowRight") {
            e.preventDefault();
            ampmEl.focus();
        }
    });

    ampmEl.addEventListener("keydown", (e) => {
        const k = e.key.toLowerCase();
        if (k === 'a') {
            e.preventDefault();
            currentAmPm = "AM";
            updateWheelDisplay();
        } else if (k === 'p') {
            e.preventDefault();
            currentAmPm = "PM";
            updateWheelDisplay();
        } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
            e.preventDefault();
            toggleAmPm();
        } else if (e.key === "ArrowLeft") {
            e.preventDefault();
            minEl.focus();
        }
    });

    [hourEl, minEl, ampmEl].forEach(el => {
        el.addEventListener("wheel", (e) => {
            e.preventDefault();
            const delta = e.deltaY < 0 ? 1 : -1;
            if (el === hourEl) stepHour(delta);
            else if (el === minEl) stepMinute(delta);
            else if (el === ampmEl) toggleAmPm();
        });
    });
}

/* ============================================================
   CUSTOM CALENDAR PICKER
   ============================================================ */
let calActiveTarget = null;
let calViewingYear = 2026;
let calViewingMonth = 9;

function formatDisplayDate(dateStr) {
    if (!dateStr) return "";
    const [y, m, d] = dateStr.split("-").map(Number);
    const dt = new Date(y, m - 1, d);
    return dt.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function openCustomCalendar(targetId) {
    calActiveTarget = targetId;
    const currentVal = document.getElementById(targetId).value || getCentralTimeComponents().dateStr;
    const [y, m, d] = currentVal.split("-").map(Number);
    calViewingYear = y;
    calViewingMonth = m - 1;
    renderCalendarGrid();
    document.getElementById("customCalendarModal").style.display = "flex";
}

function closeCustomCalendar() {
    document.getElementById("customCalendarModal").style.display = "none";
}

function calPrevMonth() {
    calViewingMonth--;
    if (calViewingMonth < 0) {
        calViewingMonth = 11;
        calViewingYear--;
    }
    renderCalendarGrid();
}

function calNextMonth() {
    calViewingMonth++;
    if (calViewingMonth > 11) {
        calViewingMonth = 0;
        calViewingYear++;
    }
    renderCalendarGrid();
}

function calSelectToday() {
    const ctNow = getCentralTimeComponents();
    chooseDate(ctNow.dateStr);
}

function renderCalendarGrid() {
    const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    document.getElementById("calMonthYearText").innerText = `${monthNames[calViewingMonth]} ${calViewingYear}`;

    const grid = document.getElementById("calDaysGrid");
    grid.innerHTML = "";

    const firstDayIndex = new Date(calViewingYear, calViewingMonth, 1).getDay();
    const lastDate = new Date(calViewingYear, calViewingMonth + 1, 0).getDate();
    const prevLastDate = new Date(calViewingYear, calViewingMonth, 0).getDate();

    const selectedVal = document.getElementById(calActiveTarget).value;
    const ctNow = getCentralTimeComponents();

    for (let i = firstDayIndex; i > 0; i--) {
        const d = prevLastDate - i + 1;
        const cell = document.createElement("div");
        cell.className = "cal-day-cell other-month";
        cell.innerText = d;
        grid.appendChild(cell);
    }

    for (let d = 1; d <= lastDate; d++) {
        const cell = document.createElement("div");
        cell.className = "cal-day-cell";
        cell.innerText = d;

        const mStr = (calViewingMonth + 1) < 10 ? `0${calViewingMonth + 1}` : (calViewingMonth + 1);
        const dStr = d < 10 ? `0${d}` : d;
        const thisDateStr = `${calViewingYear}-${mStr}-${dStr}`;

        if (thisDateStr === selectedVal) cell.classList.add("selected");
        if (thisDateStr === ctNow.dateStr) cell.classList.add("today");

        cell.onclick = () => chooseDate(thisDateStr);
        grid.appendChild(cell);
    }
}

function chooseDate(dateStr) {
    document.getElementById(calActiveTarget).value = dateStr;
    const label = formatDisplayDate(dateStr);

    if (calActiveTarget === "modalDate") {
        document.getElementById("modalDateLabel").innerText = label;
    } else if (calActiveTarget === "recurEndDate") {
        document.getElementById("recurEndDateLabel").innerText = label;
        tempRecur.endDate = dateStr;
    }

    closeCustomCalendar();
}

/* ============================================================
   SPECIFIC DATE & REPEAT ALARM LOGIC
   ============================================================ */
function toggleSpecificDate() {
    const chkDate = document.getElementById("chkSpecificDate");
    const chkRepeat = document.getElementById("chkRepeat");
    const dateField = document.getElementById("specificDateField");
    const repeatRow = document.getElementById("repeatConfigRow");

    if (chkDate.checked) {
        chkRepeat.checked = false;
        if (currentRecurrence) currentRecurrence.enabled = false;
        if (repeatRow) repeatRow.style.display = "none";
        dateField.style.display = "flex";
    } else {
        dateField.style.display = "none";
    }
}

function toggleRepeatAlarm() {
    const chkDate = document.getElementById("chkSpecificDate");
    const chkRepeat = document.getElementById("chkRepeat");
    const dateField = document.getElementById("specificDateField");
    const repeatRow = document.getElementById("repeatConfigRow");

    if (chkRepeat.checked) {
        chkDate.checked = false;
        if (dateField) dateField.style.display = "none";

        if (!currentRecurrence) {
            currentRecurrence = {
                enabled: true,
                interval: 1,
                unit: "week",
                days: [1],
                ends: "never",
                endDate: "2027-01-25",
                occurrences: 13,
                occurrenceCount: 0
            };
        } else {
            currentRecurrence.enabled = true;
        }
        if (repeatRow) repeatRow.style.display = "flex";
        updateRepeatSummaryText();
    } else {
        if (currentRecurrence) currentRecurrence.enabled = false;
        if (repeatRow) repeatRow.style.display = "none";
    }
}

function updateRepeatSummaryText() {
    if (!currentRecurrence || !currentRecurrence.enabled) return;

    const summaryEl = document.getElementById("repeatSummaryText");
    if (!summaryEl) return;

    const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const interval = currentRecurrence.interval || 1;
    const unit = currentRecurrence.unit || "week";

    let txt = "";

    if (unit === "day") {
        txt = interval > 1 ? `Every ${interval} days` : "Every day";
    } else if (unit === "week") {
        const days = currentRecurrence.days || [];
        if (days.length > 0) {
            const dStr = days.map(d => dayNames[d]).join(", ");
            txt = `Every ${interval > 1 ? interval + " weeks" : "week"} on ${dStr}`;
        } else {
            txt = interval > 1 ? `Every ${interval} weeks` : "Every week";
        }
    } else if (unit === "month") {
        if (currentRecurrence.monthOption && currentRecurrence.monthOption.label) {
            txt = currentRecurrence.monthOption.label;
            if (interval > 1) {
                txt += ` (every ${interval} months)`;
            }
        } else {
            txt = interval > 1 ? `Every ${interval} months` : "Every month";
        }
    } else if (unit === "year") {
        txt = interval > 1 ? `Every ${interval} years` : "Every year";
    } else {
        txt = `Repeat every ${interval} ${unit}`;
    }

    summaryEl.innerText = txt;
}

/* ============================================================
   CUSTOM RECURRENCE MODAL
   ============================================================ */
function openCustomRecurrenceModal() {
    if (!currentRecurrence) {
        tempRecur = {
            interval: 1,
            unit: "week",
            days: [1],
            ends: "never",
            endDate: "2027-01-25",
            occurrences: 13,
            occurrenceCount: 0
        };
    } else {
        tempRecur = { ...currentRecurrence };
    }

    document.getElementById("recurIntervalDisplay").innerText = tempRecur.interval || 1;
    selectRecurUnit(tempRecur.unit || "week", false);

    document.querySelectorAll(".g-days-row .g-day-btn").forEach(btn => {
        const d = parseInt(btn.getAttribute("data-day"), 10);
        if ((tempRecur.days || []).includes(d)) btn.classList.add("active");
        else btn.classList.remove("active");
    });

    const ends = tempRecur.ends || "never";
    if (ends === "never") document.getElementById("gEndNever").checked = true;
    else if (ends === "on") document.getElementById("gEndOn").checked = true;
    else if (ends === "after") document.getElementById("gEndAfter").checked = true;

    document.getElementById("recurEndDate").value = tempRecur.endDate || "2027-01-25";
    document.getElementById("recurEndDateLabel").innerText = formatDisplayDate(tempRecur.endDate || "2027-01-25");
    document.getElementById("recurOccurrencesDisplay").innerText = tempRecur.occurrences || 13;

    onRecurEndChange();
    document.getElementById("customRecurrenceModal").style.display = "flex";
}

function closeCustomRecurrenceModal() {
    document.getElementById("customRecurrenceModal").style.display = "none";
    document.getElementById("recurUnitMenu").classList.remove("show");
    document.getElementById("recurUnitCaret").classList.remove("open");
}

function stepInterval(delta) {
    let val = tempRecur.interval + delta;
    if (val < 1) val = 1;
    if (val > 99) val = 99;
    tempRecur.interval = val;
    document.getElementById("recurIntervalDisplay").innerText = val;
}

function stepOccurrences(delta) {
    let val = (tempRecur.occurrences || 13) + delta;
    if (val < 1) val = 1;
    if (val > 999) val = 999;
    tempRecur.occurrences = val;
    document.getElementById("recurOccurrencesDisplay").innerText = val;
}

function toggleUnitDropdown() {
    const menu = document.getElementById("recurUnitMenu");
    const caret = document.getElementById("recurUnitCaret");
    menu.classList.toggle("show");
    caret.classList.toggle("open");
}

function buildMonthlyOptions() {
    const dateVal = document.getElementById("modalDate").value || getCentralTimeComponents().dateStr;
    const [y, m, d] = dateVal.split("-").map(Number);
    const dt = new Date(y, m - 1, d);

    const dayOfMonth = dt.getDate();
    const weekdayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const nthWords = ["first", "second", "third", "fourth", "fifth"];

    const weekday = dt.getDay();
    const weekdayName = weekdayNames[weekday];
    const nth = Math.ceil(dayOfMonth / 7);
    const nthWord = nthWords[nth - 1] || `${nth}th`;

    const lastDateOfMonth = new Date(y, m, 0).getDate();
    const isLast = (dayOfMonth + 7 > lastDateOfMonth);

    const options = [
        { key: "day", label: `Monthly on day ${dayOfMonth}`, data: { type: "day", day: dayOfMonth } },
        { key: "nth", label: `Monthly on the ${nthWord} ${weekdayName}`, data: { type: "nth", nth: nth, weekday: weekday } }
    ];

    if (isLast) {
        options.push({
            key: "last",
            label: `Monthly on the last ${weekdayName}`,
            data: { type: "last", weekday: weekday }
        });
    }

    if (!tempRecur.monthOption) {
        tempRecur.monthOption = options[0];
    }

    const menu = document.getElementById("recurMonthMenu");
    menu.innerHTML = options.map(opt => {
        const isSelected = tempRecur.monthOption && tempRecur.monthOption.label === opt.label;
        return `<div class="g-dropdown-item ${isSelected ? 'selected' : ''}" onclick='selectMonthOption(${JSON.stringify(opt)})'>${opt.label}</div>`;
    }).join("");

    document.getElementById("recurMonthLabel").innerText = tempRecur.monthOption.label;
}

function toggleMonthDropdown() {
    const menu = document.getElementById("recurMonthMenu");
    const caret = document.getElementById("recurMonthCaret");
    const btn = document.getElementById("recurMonthBtn");
    menu.classList.toggle("show");
    caret.classList.toggle("open");
    btn.classList.toggle("active");
}

function selectMonthOption(opt) {
    tempRecur.monthOption = opt;
    document.getElementById("recurMonthLabel").innerText = opt.label;

    document.querySelectorAll("#recurMonthMenu .g-dropdown-item").forEach(el => {
        el.classList.toggle("selected", el.innerText.trim() === opt.label);
    });

    const menu = document.getElementById("recurMonthMenu");
    const caret = document.getElementById("recurMonthCaret");
    const btn = document.getElementById("recurMonthBtn");
    menu.classList.remove("show");
    caret.classList.remove("open");
    btn.classList.remove("active");
}

function selectRecurUnit(unit, close = true) {
    tempRecur.unit = unit;
    document.getElementById("recurUnitLabel").innerText = unit;

    document.querySelectorAll(".g-dropdown-item").forEach(item => {
        item.classList.toggle("selected", item.innerText.trim() === unit);
    });

    document.getElementById("recurOnWeekGroup").style.display = (unit === "week") ? "flex" : "none";
    const monthGroup = document.getElementById("recurOnMonthGroup");
    monthGroup.style.display = (unit === "month") ? "flex" : "none";

    if (unit === "month") {
        buildMonthlyOptions();
    }

    if (close) {
        document.getElementById("recurUnitMenu").classList.remove("show");
        document.getElementById("recurUnitCaret").classList.remove("open");
    }
}

function toggleRecurDay(btn) {
    btn.classList.toggle("active");
    const d = parseInt(btn.getAttribute("data-day"), 10);
    if (!tempRecur.days) tempRecur.days = [];
    if (btn.classList.contains("active")) {
        if (!tempRecur.days.includes(d)) tempRecur.days.push(d);
    } else {
        tempRecur.days = tempRecur.days.filter(x => x !== d);
    }
}

function onRecurEndChange() {
    const ends = document.querySelector('input[name="gRecurEnds"]:checked').value;
    tempRecur.ends = ends;

    const dateBtn = document.getElementById("recurEndDateBtn");
    const occurStepper = document.getElementById("occurrencesStepper");

    if (ends === "on") {
        dateBtn.classList.remove("disabled");
        occurStepper.classList.add("disabled");
    } else if (ends === "after") {
        dateBtn.classList.add("disabled");
        occurStepper.classList.remove("disabled");
    } else {
        dateBtn.classList.add("disabled");
        occurStepper.classList.add("disabled");
    }
}

function saveCustomRecurrence() {
    if (tempRecur.unit === "week" && (!tempRecur.days || tempRecur.days.length === 0)) {
        alert("Please select at least one day of the week!");
        return;
    }

    currentRecurrence = {
        enabled: true,
        interval: tempRecur.interval,
        unit: tempRecur.unit,
        days: tempRecur.days || [],
        monthOption: tempRecur.monthOption || null,
        ends: tempRecur.ends,
        endDate: document.getElementById("recurEndDate").value,
        occurrences: tempRecur.occurrences,
        occurrenceCount: (currentRecurrence && currentRecurrence.occurrenceCount) || 0
    };

    updateRepeatSummaryText();
    closeCustomRecurrenceModal();
}

/* ============================================================
   OPEN ADD & EDIT MODAL
   ============================================================ */
function openAddModal() {
    editingAlarmId = null;
    document.getElementById("modalAlarmTitle").innerText = "Add alarm";

    const ctNow = getCentralTimeComponents();
    document.getElementById("modalDate").value = ctNow.dateStr;
    document.getElementById("modalDateLabel").innerText = formatDisplayDate(ctNow.dateStr);
    document.getElementById("modalNote").value = "";

    document.getElementById("chkSpecificDate").checked = false;
    toggleSpecificDate();

    document.getElementById("chkRepeat").checked = false;
    currentRecurrence = null;
    document.getElementById("repeatConfigRow").style.display = "none";

    stopPreviewSound();
    const soundSelect = document.getElementById("modalSound");
    if (soundSelect) soundSelect.selectedIndex = 0;
    document.getElementById("modalSnooze").value = "20";

    currentH = 10;
    currentM = 45;
    currentAmPm = "PM";
    hourBuffer = "";
    minBuffer = "";
    updateWheelDisplay();

    document.getElementById("alarmModal").style.display = "flex";
    setTimeout(() => document.getElementById("pickHour").focus(), 50);
}

function openEditModal(alarmId) {
    const alarm = alarmsList.find(a => a.id === alarmId);
    if (!alarm) return;

    stopPreviewSound();

    let soundPath = alarm.sound || "sound/Chimes.wav";
    if (!soundPath.startsWith("sound/")) {
        soundPath = "sound/" + soundPath;
    }
    const soundSelect = document.getElementById("modalSound");
    if (soundSelect) soundSelect.value = soundPath;

    editingAlarmId = alarm.id;
    document.getElementById("modalAlarmTitle").innerText = "Edit alarm";

    const [datePart, timePart] = alarm.alarmTime.split(" ");
    document.getElementById("modalDate").value = datePart;
    document.getElementById("modalDateLabel").innerText = formatDisplayDate(datePart);
    document.getElementById("modalNote").value = alarm.note || "";

    let rec = null;
    try {
        if (alarm.recurrence) rec = JSON.parse(alarm.recurrence);
    } catch (e) { }

    if (rec && rec.enabled) {
        currentRecurrence = JSON.parse(JSON.stringify(rec));
        document.getElementById("chkRepeat").checked = true;
        document.getElementById("chkSpecificDate").checked = false;
        document.getElementById("specificDateField").style.display = "none";
        document.getElementById("repeatConfigRow").style.display = "flex";
        updateRepeatSummaryText();
    } else {
        currentRecurrence = null;
        document.getElementById("chkRepeat").checked = false;
        document.getElementById("chkSpecificDate").checked = true;
        document.getElementById("specificDateField").style.display = "flex";
        document.getElementById("repeatConfigRow").style.display = "none";
    }

    let [h, m] = timePart.split(":").map(Number);
    currentAmPm = h >= 12 ? "PM" : "AM";
    currentH = h % 12 || 12;
    currentM = m;
    hourBuffer = "";
    minBuffer = "";
    updateWheelDisplay();

    document.getElementById("alarmModal").style.display = "flex";
    setTimeout(() => document.getElementById("pickHour").focus(), 50);
}

/* ============================================================
   INITIALIZATION
   ============================================================ */
setupTimePickerEvents();
initSoundOptions();
initAlarms();

/* ============================================================
   SETTINGS MENU & CACHE CONTROLLER
   ============================================================ */
function toggleSettingsMenu(e) {
    if (e) e.stopPropagation();
    const menu = document.getElementById("settingsMenu");
    if (menu) menu.classList.toggle("show");
}

function closeSettingsMenu() {
    const menu = document.getElementById("settingsMenu");
    if (menu) menu.classList.remove("show");
}

function openNotificationEmailsModal() {
    closeSettingsMenu();
    openSettingsModal();
}

function clearAllCache() {
    closeSettingsMenu();
    document.getElementById("clearCacheModal").style.display = "flex";
}

function executeClearCache() {
    closeModal("clearCacheModal");
    try {
        localStorage.clear();
        alarmsList = [];
        renderAlarmCards();
        showToast("Cache cleared successfully! Reloading...", "info");
        setTimeout(() => {
            location.reload();
        }, 600);
    } catch (e) {
        console.error("Lỗi xóa cache:", e);
        showToast("Failed to clear cache!", "warning");
    }
}

document.addEventListener("click", (e) => {
    const menu = document.getElementById("settingsMenu");
    const btn = document.getElementById("settingsNavItem");
    if (menu && menu.classList.contains("show")) {
        if (!menu.contains(e.target) && (!btn || !btn.contains(e.target))) {
            closeSettingsMenu();
        }
    }
});

/* ============================================================
   BUILD MENU, WEBSITE & TEST EMAIL HANDLERS
   ============================================================ */
const GAS_TEST_URL = "https://script.google.com/macros/s/AKfycbz-acQMjq27JczkPaQL0EYkPn3PgooZRTgGKM6QbOqeqERvUhMbVQSx6Jt_dcM93-Kr/exec";

// 1. Mở Build Menu Panel
function openBuildMenuModal() {
    closeSettingsMenu();
    document.getElementById("buildMenuModal").style.display = "flex";
}

// 2. Chuyển hướng tới trang Website
function openWebsite() {
    closeSettingsMenu();
    window.open("https://softwaresupport-fastboy.github.io/ron-alarm/", "_blank");
}

// 3. Gửi email test về hộp thư
async function sendTestAlarmEmail() {
    closeSettingsMenu();
    const emails = getSavedEmails();
    showToast("Sending test email...", "info");

    try {
        await fetch(`${GAS_TEST_URL}?action=testEmail&target=${encodeURIComponent(emails)}`, {
            method: "GET",
            mode: "no-cors"
        });
        showToast("Test email sent! Please check your inbox.", "success");
    } catch (err) {
        console.error("Test email error:", err);
        showToast("Failed to send test email!", "warning");
    }
}

/* ============================================================
   OPEN ALARM PANEL PREVIEW & RESET APPS HANDLERS
   ============================================================ */
function openAlarmPreviewPanel() {
    closeSettingsMenu();
    showToast("Opening sample Alarm Panel...", "info");

    if (window.pywebview && window.pywebview.api && window.pywebview.api.open_alarm_panel) {
        window.pywebview.api.open_alarm_panel();
    } else {
        fetch("/api/preview-alarm-panel").catch(() => {
            showToast("Failed to open Alarm Panel preview!", "warning");
        });
    }
}

function confirmResetApps() {
    closeSettingsMenu();
    const modal = document.getElementById("resetAppsModal");
    if (modal) {
        modal.style.display = "flex";
    } else if (confirm("Do you want to reset all files and reload Ron Alarm?")) {
        executeResetApps();
    }
}

function executeResetApps() {
    closeModal("resetAppsModal");
    try {
        localStorage.clear();
    } catch (e) { }

    showToast("Resetting application... Ron Alarm will restart shortly.", "info");

    try {
        if (window.pywebview && window.pywebview.api && window.pywebview.api.reset_apps) {
            window.pywebview.api.reset_apps();
        }
    } catch (e) { }

    fetch("/api/reset-app", { method: "POST" }).catch(() => { });
}

/* ============================================================
   KIỂM TRA VÀ CHỈ HIỂN THỊ TÍNH NĂNG PC TRÊN PC APP
   ============================================================ */
function initPCFeaturesVisibility() {
    const isDesktopApp = window.location.hostname === '127.0.0.1'
        || window.location.hostname === 'localhost'
        || window.location.protocol === 'file:'
        || !!window.pywebview;

    if (isDesktopApp) {
        document.querySelectorAll('.pc-only').forEach(el => {
            el.style.setProperty('display', 'flex', 'important');
        });
    }
}

document.addEventListener("DOMContentLoaded", initPCFeaturesVisibility);
window.addEventListener("pywebviewready", initPCFeaturesVisibility);
initPCFeaturesVisibility();