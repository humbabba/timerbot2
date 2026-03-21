/**
 * Timer Runner — Meeting timer with per-speaker countdown and Web Audio API warnings.
 * Reads timerConfig global: { name, end_time, participant_count, warnings[], state_url, settings_url, csrf_token }
 */

import { playSound } from './sounds';

(function () {
    'use strict';

    // ── DOM refs ──
    const meetingCountdownEl = document.getElementById('meeting-countdown');
    const timePerPersonLabel = document.getElementById('time-per-person-label');
    const speakerPanel       = document.getElementById('speaker-panel');
    const speakerNumberEl    = document.getElementById('speaker-number');
    const speakerTotalEl     = document.getElementById('speaker-total');
    const speakerCountdownEl = document.getElementById('speaker-countdown');
    const speakerStatusEl    = document.getElementById('speaker-status');
    const btnStart           = document.getElementById('btn-start');
    const btnPrev            = document.getElementById('btn-prev');
    const btnNext            = document.getElementById('btn-next');
    const btnUndo            = document.getElementById('btn-undo');
    const btnPause           = document.getElementById('btn-pause');
    const btnStop            = document.getElementById('btn-stop');
    const historySection     = document.getElementById('history-section');
    const historyBody        = document.getElementById('history-body');
    const completedSection   = document.getElementById('completed-section');
    const timePerPersonDiv   = document.getElementById('time-per-person');

    // ── Config ──
    const config        = window.timerConfig;
    let totalSpeakers = config.participant_count;
    const termSingular = config.participant_term || 'speaker';
    const termPlural   = config.participant_term_plural || 'speakers';
    const termSingularUc = termSingular.charAt(0).toUpperCase() + termSingular.slice(1);

    // ── State ──
    let currentSpeaker       = 0;   // 0-indexed
    let speakerStartMs       = 0;
    let speakerAllottedMs    = 0;
    let paused               = false;
    let pauseStartMs         = 0;
    let totalPausedMs        = 0;
    let running              = false;
    let completed            = false;

    // ── Clock offset (server time sync) ──
    let clockOffset = 0;
    function serverNow() { return Date.now() + clockOffset; }
    function updateClockOffset(serverTimeMs) {
        if (!serverTimeMs) return;
        const newOffset = serverTimeMs - Date.now();
        // Only adjust backward if the jump is significant (>2s real drift).
        // Small backward adjustments are network jitter and would make
        // countdowns tick backward for a split second.
        if (newOffset >= clockOffset || clockOffset - newOffset > 2000) {
            clockOffset = newOffset;
        }
    }

    // ── Undo state ──
    let undoState                = null;
    let undoTimeout              = null;
    let undoCountdownInterval    = null;

    // Parse a time-of-day string into a future timestamp.
    // If the time is already past and the timer isn't actively running, assume tomorrow.
    function parseEndTime(timeStr) {
        const [ph, pm, ps] = timeStr.split(':').map(Number);
        const d = new Date();
        d.setHours(ph, pm, ps || 0, 0);
        if (d.getTime() < serverNow() && !running && !completed) {
            d.setDate(d.getDate() + 1);
        }
        return d.getTime();
    }

    let endTime = parseEndTime(config.end_time);
    let endTimeStr = config.end_time;
    const warnings     = (config.warnings || []).slice().sort((a, b) => b.seconds_before - a.seconds_before);
    let meetingTick          = null;
    let speakerTick          = null;
    let firedWarnings        = new Set();
    const history            = [];
    // ── Helpers ──
    function formatTime(ms) {
        const negative = ms < 0;
        const abs = Math.abs(ms);
        const totalSec = Math.floor(abs / 1000);
        const h = Math.floor(totalSec / 3600);
        const m = Math.floor((totalSec % 3600) / 60);
        const s = totalSec % 60;
        const pad = (n) => String(n).padStart(2, '0');
        const str = h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
        return negative ? `-${str}` : str;
    }

    function remainingMeetingMs() {
        return endTime - serverNow();
    }

    function calcTimePerSpeaker() {
        const remaining = remainingMeetingMs();
        const speakersLeft = totalSpeakers - currentSpeaker;
        return speakersLeft > 0 ? Math.max(0, remaining / speakersLeft) : 0;
    }

    // ── Lock Lost overlay ──
    let lockLost = false;

    function handleLockLost(lockedByName) {
        if (lockLost) return;
        lockLost = true;

        // Stop all timers
        running = false;
        paused = false;
        clearInterval(speakerTick);

        // Create overlay
        const overlay = document.createElement('div');
        overlay.className = 'fixed inset-0 bg-timerbot-black/90 flex items-center justify-center z-50 p-4';
        overlay.innerHTML = `
            <div class="bg-timerbot-panel-light rounded-sm border border-divider p-8 max-w-md text-center">
                <h2 class="text-2xl font-bold text-timerbot-red mb-4" style="font-family: var(--font-display);">Lock Lost</h2>
                <p class="text-text mb-2">Another user has taken over this timer.</p>
                ${lockedByName ? `<p class="text-text-muted text-sm mb-6">Now being run by <span class="text-timerbot-teal">${lockedByName}</span>.</p>` : '<p class="text-text-muted text-sm mb-6">Your session has expired.</p>'}
                <a href="${window.location.href}" class="btn btn-primary no-underline px-6 py-3">Try Again</a>
            </div>
        `;
        document.body.appendChild(overlay);
    }

    // ── Server state sync ──
    function applySettingsFromServer(data) {
        if (!data) return;

        // Skip server settings briefly after a local change so stale
        // heartbeat responses don't revert what the user just set.
        if (Date.now() - settingsChangedAt < 2000) return;

        const newEndTime = data.end_time;
        const newCount = data.participant_count;

        // Compare parsed ms value for end_time to avoid HH:MM vs HH:MM:SS format issues
        const endTimeChanged = newEndTime && parseEndTime(newEndTime) !== endTime;
        const countChanged = newCount && newCount !== totalSpeakers;

        if (!endTimeChanged && !countChanged) return;

        // Defer end time update only while the user is actively editing (input within last 3s)
        const applyEndTime = endTimeChanged && !endTimeEditing;

        if (!applyEndTime && !countChanged) return;

        // Update setting inputs before applying
        if (applyEndTime && settingEndTimeEl) {
            settingEndTimeEl.value = newEndTime;
        }
        if (countChanged && settingParticipants) {
            settingParticipants.value = newCount;
        }

        // Apply via the same code path used for local changes (skip server persist)
        updateSettings(
            countChanged ? newCount : totalSpeakers,
            applyEndTime ? newEndTime : endTimeStr,
            false
        );
    }

    function syncState() {
        if (!config.state_url) return;

        let status = 'idle';
        if (completed) status = 'completed';
        else if (paused) status = 'paused';
        else if (running) status = 'running';

        const state = {
            status,
            current_speaker: running || completed ? currentSpeaker + 1 : 0,
            total_speakers: totalSpeakers,
            end_time: endTimeStr,
            end_time_ms: endTime,
            speaker_allotted_ms: speakerAllottedMs,
            speaker_started_at: speakerStartMs,
            total_paused_ms: totalPausedMs,
            paused_at: paused ? pauseStartMs : null,
            history,
        };

        fetch(config.state_url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRF-TOKEN': config.csrf_token,
                'X-Requested-With': 'XMLHttpRequest',
            },
            body: JSON.stringify({ state }),
        }).then(res => {
            if (res.status === 423) {
                res.json().then(data => handleLockLost(data.locked_by_name));
            } else if (res.ok) {
                res.json().then(data => {
                    updateClockOffset(data.server_time_ms);
                    applySettingsFromServer(data);
                });
            }
        }).catch(() => {});
    }

    // Heartbeat: sync state every second (also keeps lock alive when idle)
    setInterval(() => {
        if (lockLost) return;
        if (running || paused) {
            syncState();
        } else {
            // Idle heartbeat — minimal POST to keep the lock alive
            fetch(config.state_url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRF-TOKEN': config.csrf_token,
                    'X-Requested-With': 'XMLHttpRequest',
                },
                body: JSON.stringify({ state: { status: 'idle' } }),
            }).then(res => {
                if (res.status === 423) {
                    res.json().then(data => handleLockLost(data.locked_by_name));
                } else if (res.ok) {
                    res.json().then(data => {
                        updateClockOffset(data.server_time_ms);
                        applySettingsFromServer(data);
                    });
                }
            }).catch(() => {});
        }
    }, 1000);

    // ── Visual feedback ──
    function flashSpeakerPanel() {
        speakerPanel.classList.add('animate-pulse');
        setTimeout(() => speakerPanel.classList.remove('animate-pulse'), 600);
    }

    function updatePrevBtnVisibility() {
        if (running && !completed) {
            btnPrev.classList.remove('hidden');
            if (currentSpeaker > 0) {
                btnPrev.disabled = false;
                btnPrev.classList.remove('opacity-30', 'cursor-not-allowed');
            } else {
                btnPrev.disabled = true;
                btnPrev.classList.add('opacity-30', 'cursor-not-allowed');
            }
        } else {
            btnPrev.classList.add('hidden');
        }
    }

    function clearUndo() {
        clearTimeout(undoTimeout);
        clearInterval(undoCountdownInterval);
        undoState = null;
        undoTimeout = null;
        undoCountdownInterval = null;
        btnUndo.classList.add('hidden');
    }

    function updateSpeakerColor(remainMs) {
        speakerCountdownEl.classList.remove('text-timerbot-green', 'text-timerbot-green', 'text-timerbot-red');
        speakerPanel.classList.remove('border-timerbot-green', 'border-timerbot-green', 'border-timerbot-red');

        if (remainMs <= 0) {
            speakerCountdownEl.classList.add('text-timerbot-red');
            speakerPanel.classList.add('border-timerbot-red');
        } else {
            speakerCountdownEl.classList.add('text-timerbot-green');
            speakerPanel.classList.add('border-timerbot-green');
        }
    }

    // ── Meeting countdown (always ticking) ──
    function updateMeetingCountdown() {
        const remaining = remainingMeetingMs();
        meetingCountdownEl.textContent = formatTime(remaining);
        if (remaining <= 0) {
            meetingCountdownEl.classList.add('text-timerbot-red');
        } else {
            meetingCountdownEl.classList.remove('text-timerbot-red');
        }
    }

    let lastTppText = '';
    let tppFlashTimer = null;

    function updateTimePerPersonLabel(perPersonMs, forceOverTime) {
        const overTime = forceOverTime ||
            (running && !completed && speakerStartMs > 0 && speakerRemainingMs() < 0);

        if (running && !completed) {
            // While running (normal, paused, or overtime): show what future speakers will get.
            // Subtract current speaker's reserved time from meeting remaining, divide by future count.
            const futureCount = totalSpeakers - currentSpeaker - 1;
            if (futureCount > 0) {
                const meetingMs = remainingMeetingMs();
                const speakerReserved = Math.max(0, speakerRemainingMs());
                const tpp = Math.max(0, (meetingMs - speakerReserved) / futureCount);
                timePerPersonLabel.textContent = `${formatTime(tpp)} per ${termSingular} (${futureCount} remaining)`;
            } else {
                timePerPersonLabel.textContent = `Last ${termSingular} — no time to redistribute`;
            }
        } else if (!running || completed) {
            // Idle or completed: equal share across all speakers
            timePerPersonLabel.textContent = `${formatTime(perPersonMs)} per ${termSingular} (${totalSpeakers} ${termPlural})`;
        }

        // Flash red briefly each time the value decrements while over time
        const currentText = timePerPersonLabel.textContent;
        if (overTime && currentText !== lastTppText) {
            lastTppText = currentText;
            clearTimeout(tppFlashTimer);
            timePerPersonDiv.classList.remove('text-text-muted');
            timePerPersonDiv.classList.add('text-timerbot-red');
            tppFlashTimer = setTimeout(() => {
                timePerPersonDiv.classList.remove('text-timerbot-red');
                timePerPersonDiv.classList.add('text-text-muted');
            }, 500);
        } else if (!overTime) {
            lastTppText = '';
            clearTimeout(tppFlashTimer);
            timePerPersonDiv.classList.remove('text-timerbot-red');
            timePerPersonDiv.classList.add('text-text-muted');
        }
    }

    // ── Live settings controls ──
    const settingEndTimeEl     = document.getElementById('setting-end-time');
    const settingParticipants  = document.getElementById('setting-participants');

    function updateSettings(newParticipants, newEndTimeStr, persistToServer) {
        if (persistToServer === undefined) persistToServer = true;

        // Guard: can't reduce below speakers already done + 1 (current speaker)
        const minParticipants = running ? currentSpeaker + 1 : 1;
        if (newParticipants < minParticipants) {
            newParticipants = minParticipants;
            settingParticipants.value = minParticipants;
        }

        totalSpeakers = newParticipants;
        speakerTotalEl.textContent = totalSpeakers;

        // Parse new end time (bumps to tomorrow if past and not running)
        endTime = parseEndTime(newEndTimeStr);
        endTimeStr = newEndTimeStr;

        // Recalculate current speaker's allotted time if running
        if (running && !completed) {
            speakerAllottedMs = calcTimePerSpeaker();
        }

        // Update label with current value
        updateTimePerPersonLabel(running ? speakerAllottedMs : calcTimePerSpeaker());
        updateMeetingCountdown();

        if (!persistToServer) return;

        settingsChangedAt = Date.now();

        // Persist to server
        if (config.settings_url) {
            fetch(config.settings_url, {
                method: 'PATCH',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRF-TOKEN': config.csrf_token,
                    'X-Requested-With': 'XMLHttpRequest',
                },
                body: JSON.stringify({
                    participant_count: totalSpeakers,
                    end_time: newEndTimeStr,
                }),
            }).catch(() => {});
        }

        // Sync run state so show page picks up changes
        syncState();
    }

    // Apply settings only on blur so mid-edit intermediate values
    // (e.g. :30 → :04 → :40) never get sent to the server.
    // Track "actively editing" — true while the user has had input within the last 3s.
    // Server updates are deferred while this flag is set, but once the user stops
    // typing for 3s the flag clears and server updates flow through even if the
    // field is still focused.
    let endTimeEditing = false;
    let endTimeEditTimer = null;
    let settingsChangedAt = 0;   // timestamp of last local settings change

    if (settingEndTimeEl) {
        settingEndTimeEl.addEventListener('input', () => {
            endTimeEditing = true;
            clearTimeout(endTimeEditTimer);
            endTimeEditTimer = setTimeout(() => { endTimeEditing = false; }, 3000);
        });
        settingEndTimeEl.addEventListener('blur', () => {
            endTimeEditing = false;
            clearTimeout(endTimeEditTimer);
            if (parseEndTime(settingEndTimeEl.value) !== endTime) {
                updateSettings(totalSpeakers, settingEndTimeEl.value);
            }
        });
    }

    if (settingParticipants) {
        settingParticipants.addEventListener('blur', () => {
            const val = parseInt(settingParticipants.value, 10);
            if (!isNaN(val) && val !== totalSpeakers) {
                updateSettings(val, settingEndTimeEl.value);
            }
        });
    }

    // ── Speaker tick ──
    function speakerElapsedMs() {
        if (paused) {
            return pauseStartMs - speakerStartMs - totalPausedMs;
        }
        return serverNow() - speakerStartMs - totalPausedMs;
    }

    function speakerRemainingMs() {
        return speakerAllottedMs - speakerElapsedMs();
    }

    function tickSpeaker() {
        if (paused) return;

        const remainMs = speakerRemainingMs();
        speakerCountdownEl.textContent = formatTime(remainMs);
        updateSpeakerColor(remainMs);

        if (remainMs <= 0) {
            speakerStatusEl.textContent = 'Over time!';
            speakerCountdownEl.classList.add('animate-pulse');
            updateTimePerPersonLabel(speakerAllottedMs, true);
        } else {
            speakerCountdownEl.classList.remove('animate-pulse');
            speakerStatusEl.textContent = '';
        }

        // Check warnings
        const secsRemaining = remainMs / 1000;
        for (const w of warnings) {
            const key = `${currentSpeaker}-${w.seconds_before}`;
            if (!firedWarnings.has(key) && secsRemaining <= w.seconds_before && secsRemaining > w.seconds_before - 1) {
                firedWarnings.add(key);
                playSound(w.sound);
                flashSpeakerPanel();
            }
        }
    }

    // ── Actions ──
    function startSpeaker() {
        speakerAllottedMs = calcTimePerSpeaker();
        speakerStartMs    = serverNow();
        totalPausedMs     = 0;
        paused            = false;

        speakerNumberEl.textContent = currentSpeaker + 1;
        speakerPanel.classList.remove('hidden');
        speakerCountdownEl.classList.remove('animate-pulse');
        speakerStatusEl.textContent = '';
        updateTimePerPersonLabel(speakerAllottedMs);

        tickSpeaker();
    }

    function renderHistoryRow(entry) {
        const tr = document.createElement('tr');
        tr.className = 'hover:bg-timerbot-panel-light transition-colors';
        tr.innerHTML = `
            <td class="p-4 border-b border-divider/50">${termSingularUc} ${entry.speaker}</td>
            <td class="p-4 border-b border-divider/50 text-text-muted">${formatTime(entry.allotted)}</td>
            <td class="p-4 border-b border-divider/50 ${entry.over ? 'text-timerbot-red' : 'text-timerbot-green'}">${formatTime(entry.actual)}</td>
            <td class="p-4 border-b border-divider/50">
                <span class="badge ${entry.over ? 'badge-lime' : 'badge-teal'}">${entry.over ? 'Over' : 'On time'}</span>
            </td>
        `;
        historyBody.appendChild(tr);
    }

    function recordHistory() {
        const elapsed  = speakerElapsedMs();
        const allotted = speakerAllottedMs;
        const over     = elapsed > allotted;

        const entry = { speaker: currentSpeaker + 1, allotted, actual: elapsed, over };
        history.push(entry);
        renderHistoryRow(entry);
        historySection.classList.remove('hidden');
    }

    function finishMeeting() {
        running = false;
        completed = true;
        clearInterval(speakerTick);
        clearUndo();
        speakerPanel.classList.add('hidden');
        btnPrev.classList.add('hidden');
        btnNext.classList.add('hidden');
        btnPause.classList.add('hidden');
        completedSection.classList.remove('hidden');
        syncState();
    }

    function showRunningUI() {
        btnStart.classList.add('hidden');
        btnNext.classList.remove('hidden');
        btnPause.classList.remove('hidden');
        btnStop.classList.remove('hidden');
        updatePrevBtnVisibility();
    }

    function showIdleUI() {
        btnStart.classList.remove('hidden');
        btnPrev.classList.add('hidden');
        btnNext.classList.add('hidden');
        btnUndo.classList.add('hidden');
        btnPause.classList.add('hidden');
        btnStop.classList.add('hidden');
        speakerPanel.classList.add('hidden');
        completedSection.classList.add('hidden');
        historySection.classList.add('hidden');
    }

    // ── Restore state from server on page load ──
    async function restoreState() {
        try {
            const res = await fetch(config.state_url, {
                headers: { 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
            });
            if (!res.ok) return;

            const state = await res.json();
            updateClockOffset(state.server_time_ms);
            if (!state || !state.status || state.status === 'idle') {
                // Nothing to restore — sync current settings for show page
                syncState();
                return;
            }

            // Restore settings from state
            if (state.total_speakers) {
                totalSpeakers = state.total_speakers;
                speakerTotalEl.textContent = totalSpeakers;
                if (settingParticipants) settingParticipants.value = totalSpeakers;
            }
            if (state.end_time) {
                endTimeStr = state.end_time;
                if (settingEndTimeEl) settingEndTimeEl.value = state.end_time;
                if (state.end_time_ms) {
                    endTime = state.end_time_ms;
                } else {
                    const [rh, rm] = state.end_time.split(':').map(Number);
                    const d = new Date();
                    d.setHours(rh, rm, 0, 0);
                    endTime = d.getTime();
                }
            }

            // Restore history
            if (state.history && state.history.length > 0) {
                state.history.forEach(entry => {
                    history.push(entry);
                    renderHistoryRow(entry);
                });
                historySection.classList.remove('hidden');
            }

            if (state.status === 'completed') {
                completed = true;
                currentSpeaker = (state.current_speaker || 1) - 1;
                btnStart.classList.add('hidden');
                btnStop.classList.remove('hidden');
                completedSection.classList.remove('hidden');
                updateTimePerPersonLabel(calcTimePerSpeaker());
                return;
            }

            // Running or paused — restore live state
            running = true;
            currentSpeaker = (state.current_speaker || 1) - 1;
            speakerAllottedMs = state.speaker_allotted_ms || 0;
            speakerStartMs = state.speaker_started_at || serverNow();
            totalPausedMs = state.total_paused_ms || 0;

            if (state.status === 'paused' && state.paused_at) {
                paused = true;
                pauseStartMs = state.paused_at;
                btnPause.textContent = 'Resume';
                btnPause.classList.remove('bg-timerbot-panel', 'text-timerbot-teal');
                btnPause.classList.add('bg-timerbot-green', 'text-timerbot-black');
                speakerStatusEl.textContent = 'Paused';
            }

            // Show running UI
            showRunningUI();
            updatePrevBtnVisibility();
            speakerPanel.classList.remove('hidden');
            speakerNumberEl.textContent = currentSpeaker + 1;
            speakerCountdownEl.classList.remove('animate-pulse');
            updateTimePerPersonLabel(speakerAllottedMs);

            // Start ticking
            tickSpeaker();
            speakerTick = setInterval(tickSpeaker, 100);
        } catch (e) {
            // Failed to restore — sync idle for show page
            syncState();
        }
    }

    // ── Public API (attached to window) ──
    window.timerApp = {
        start() {
            running = true;
            showRunningUI();

            currentSpeaker = 0;
            startSpeaker();
            speakerTick = setInterval(tickSpeaker, 100);
            syncState();
        },

        nextSpeaker() {
            if (!running) return;

            // Save undo state before anything changes
            clearUndo();
            const undoWindowMs = Math.min(10000, speakerAllottedMs, Math.max(0, remainingMeetingMs()));
            undoState = {
                currentSpeaker,
                speakerStartMs,
                speakerAllottedMs,
                totalPausedMs,
                pauseStartMs,
                paused,
                firedWarningsSnapshot: new Set(firedWarnings),
            };

            recordHistory();

            currentSpeaker++;
            if (currentSpeaker >= totalSpeakers) {
                finishMeeting();
                return;
            }

            clearInterval(speakerTick);
            startSpeaker();
            speakerTick = setInterval(tickSpeaker, 100);
            updatePrevBtnVisibility();
            syncState();

            // Show undo button with countdown
            let undoSecsLeft = Math.ceil(undoWindowMs / 1000);
            btnUndo.textContent = `Undo (${undoSecsLeft})`;
            btnUndo.classList.remove('hidden');
            const undoExpiresAt = Date.now() + undoWindowMs;
            undoCountdownInterval = setInterval(() => {
                const secs = Math.ceil((undoExpiresAt - Date.now()) / 1000);
                if (secs <= 0) {
                    clearUndo();
                    return;
                }
                btnUndo.textContent = `Undo (${secs})`;
            }, 1000);
            undoTimeout = setTimeout(() => clearUndo(), undoWindowMs);
        },

        previousSpeaker() {
            if (!running || currentSpeaker === 0) return;

            clearUndo();

            // Pop last history entry (the speaker we're going back to)
            history.pop();
            if (historyBody.lastElementChild) {
                historyBody.removeChild(historyBody.lastElementChild);
            }
            if (history.length === 0) historySection.classList.add('hidden');

            // Clear fired warnings for both current speaker and the one we're going back to
            const currIdx = currentSpeaker;
            const prevIdx = currentSpeaker - 1;
            firedWarnings = new Set([...firedWarnings].filter(k =>
                !k.startsWith(`${currIdx}-`) && !k.startsWith(`${prevIdx}-`)
            ));

            currentSpeaker--;

            // Start fresh with recalculated time
            clearInterval(speakerTick);
            startSpeaker();
            speakerTick = setInterval(tickSpeaker, 100);
            updatePrevBtnVisibility();
            syncState();
        },

        undoNextSpeaker() {
            if (!undoState) return;

            // Pop the history entry that was just recorded
            history.pop();
            if (historyBody.lastElementChild) {
                historyBody.removeChild(historyBody.lastElementChild);
            }
            if (history.length === 0) historySection.classList.add('hidden');

            // Restore exact state
            currentSpeaker    = undoState.currentSpeaker;
            speakerStartMs    = undoState.speakerStartMs;
            speakerAllottedMs = undoState.speakerAllottedMs;
            totalPausedMs     = undoState.totalPausedMs;
            firedWarnings     = undoState.firedWarningsSnapshot;

            if (undoState.paused) {
                paused = true;
                pauseStartMs = undoState.pauseStartMs;
                btnPause.textContent = 'Resume';
                btnPause.classList.remove('bg-timerbot-panel', 'text-timerbot-teal');
                btnPause.classList.add('bg-timerbot-green', 'text-timerbot-black');
                speakerStatusEl.textContent = 'Paused';
            } else {
                paused = false;
                btnPause.textContent = 'Pause';
                btnPause.classList.remove('bg-timerbot-green', 'text-timerbot-black');
                btnPause.classList.add('bg-timerbot-panel', 'text-timerbot-teal');
                speakerStatusEl.textContent = '';
            }

            // Update UI
            speakerNumberEl.textContent = currentSpeaker + 1;
            speakerPanel.classList.remove('hidden');
            speakerCountdownEl.classList.remove('animate-pulse');
            updateTimePerPersonLabel(speakerAllottedMs);

            // Restart ticking
            clearInterval(speakerTick);
            tickSpeaker();
            speakerTick = setInterval(tickSpeaker, 100);

            clearUndo();
            updatePrevBtnVisibility();
            syncState();
        },

        togglePause() {
            if (!running) return;

            if (paused) {
                // Resume — account for pause duration, speaker keeps their frozen time
                totalPausedMs += serverNow() - pauseStartMs;
                paused = false;

                // Cap speaker time if meeting dropped below during pause
                const meetingMs = remainingMeetingMs();
                const remain = speakerRemainingMs();
                if (meetingMs < remain) {
                    speakerAllottedMs = speakerElapsedMs() + Math.max(0, meetingMs);
                }

                updateTimePerPersonLabel();

                btnPause.textContent = 'Pause';
                btnPause.classList.remove('bg-timerbot-green', 'text-timerbot-black');
                btnPause.classList.add('bg-timerbot-panel', 'text-timerbot-teal');
                speakerStatusEl.textContent = '';
            } else {
                // Pause
                pauseStartMs = serverNow();
                paused = true;
                btnPause.textContent = 'Resume';
                btnPause.classList.remove('bg-timerbot-panel', 'text-timerbot-teal');
                btnPause.classList.add('bg-timerbot-green', 'text-timerbot-black');
                speakerStatusEl.textContent = 'Paused';
            }
            syncState();
        },

        stop() {
            // Reset all state
            running = false;
            completed = false;
            paused = false;
            currentSpeaker = 0;
            speakerStartMs = 0;
            speakerAllottedMs = 0;
            totalPausedMs = 0;
            pauseStartMs = 0;
            history.length = 0;
            firedWarnings.clear();
            clearInterval(speakerTick);
            clearUndo();

            // Reset UI
            showIdleUI();
            historyBody.innerHTML = '';
            btnPause.textContent = 'Pause';
            btnPause.classList.remove('bg-timerbot-green', 'text-timerbot-black');
            btnPause.classList.add('bg-timerbot-panel', 'text-timerbot-teal');
            speakerStatusEl.textContent = '';
            speakerCountdownEl.classList.remove('animate-pulse');

            updateTimePerPersonLabel(calcTimePerSpeaker());
            syncState();

            // Release lock
            if (config.lock_release_url) {
                fetch(config.lock_release_url, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-CSRF-TOKEN': config.csrf_token,
                        'X-Requested-With': 'XMLHttpRequest',
                    },
                }).catch(() => {});
            }
        },

        playSound,
    };

    // ── Release lock on page unload ──
    window.addEventListener('beforeunload', () => {
        if (config.lock_release_url && !lockLost) {
            const data = new FormData();
            data.append('_token', config.csrf_token);
            navigator.sendBeacon(config.lock_release_url, data);
        }
    });

    // ── Wake Lock ──
    const wakeLockToggle = document.getElementById('wake-lock-toggle');
    let wakeLock = null;

    async function requestWakeLock() {
        try {
            if ('wakeLock' in navigator) {
                wakeLock = await navigator.wakeLock.request('screen');
                wakeLock.addEventListener('release', () => {
                    wakeLock = null;
                    wakeLockToggle.checked = false;
                });
            }
        } catch (e) {
            wakeLockToggle.checked = false;
        }
    }

    function releaseWakeLock() {
        if (wakeLock) {
            wakeLock.release();
            wakeLock = null;
        }
    }

    wakeLockToggle.addEventListener('change', () => {
        if (wakeLockToggle.checked) {
            requestWakeLock();
        } else {
            releaseWakeLock();
        }
    });

    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && wakeLockToggle.checked && !wakeLock) {
            requestWakeLock();
        }
    });

    // ── Init ──
    updateMeetingCountdown();
    updateTimePerPersonLabel(calcTimePerSpeaker());
    const overtimeLimitMs = (config.overtime_reset_minutes || 5) * 60000;

    meetingTick = setInterval(() => {
        updateMeetingCountdown();
        // Auto-complete when overtime reset limit is reached
        if (running && !completed && serverNow() > endTime + overtimeLimitMs) {
            recordHistory();
            finishMeeting();
            return;
        }
        if (paused && running && speakerStartMs > 0) {
            // If meeting time drops below speaker's frozen time, tick it down with warnings
            const frozenMs = speakerRemainingMs();
            const meetingMs = remainingMeetingMs();
            const effective = meetingMs < frozenMs ? Math.max(0, meetingMs) : frozenMs;
            speakerCountdownEl.textContent = formatTime(effective);
            updateSpeakerColor(effective);
            if (effective <= 0) {
                speakerStatusEl.textContent = 'Over time!';
                speakerCountdownEl.classList.add('animate-pulse');
            } else {
                speakerCountdownEl.classList.remove('animate-pulse');
                speakerStatusEl.textContent = 'Paused';
            }
            // Fire warnings based on effective remaining
            const secsRemaining = effective / 1000;
            for (const w of warnings) {
                const key = `${currentSpeaker}-${w.seconds_before}`;
                if (!firedWarnings.has(key) && secsRemaining <= w.seconds_before && secsRemaining > w.seconds_before - 1) {
                    firedWarnings.add(key);
                    playSound(w.sound);
                    flashSpeakerPanel();
                }
            }
        }
        updateTimePerPersonLabel(calcTimePerSpeaker());
    }, 1000);

    // Restore previous run state (or sync idle for show page)
    restoreState();
})();
