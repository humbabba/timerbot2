/**
 * Timer Show — Participant view that polls server state and computes all countdowns locally.
 * Reads timerShowConfig global: { id, name, end_time, participant_count, state_url }
 */

(function () {
    'use strict';

    const config = window.timerShowConfig;
    const termSingular = config.participant_term || 'speaker';
    const termPlural   = config.participant_term_plural || 'speakers';
    const termSingularUc = termSingular.charAt(0).toUpperCase() + termSingular.slice(1);

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

    // Compute initial end time from config
    // If the end time is already past, assume tomorrow's meeting
    const [h, m, s] = config.end_time.split(':').map(Number);
    const endDate = new Date();
    endDate.setHours(h, m, s || 0, 0);
    if (endDate.getTime() < serverNow()) {
        endDate.setDate(endDate.getDate() + 1);
    }
    let endTimeMs = endDate.getTime();

    // DOM refs
    const statusBadge          = document.getElementById('status-badge');
    const currentTimeEl        = document.getElementById('current-time');
    const meetingRemainingEl   = document.getElementById('meeting-remaining');
    const timePerParticipant   = document.getElementById('time-per-participant');
    const speakerLabel         = document.getElementById('speaker-label');
    const speakerTime          = document.getElementById('speaker-time');
    const wakeLockToggle       = document.getElementById('wake-lock-toggle');
    const totalParticipantsEl  = document.getElementById('total-participants');
    const endTimeDisplayEl     = document.getElementById('end-time-display');

    // State from server (key values only — all countdowns computed locally)
    let serverState = { status: 'idle' };
    let lastTppText = '';
    let tppFlashTimer = null;

    // ── Helpers ──
    function formatTime(ms) {
        const negative = ms < 0;
        const abs = Math.abs(ms);
        const totalSec = Math.floor(abs / 1000);
        const hr = Math.floor(totalSec / 3600);
        const min = Math.floor((totalSec % 3600) / 60);
        const sec = totalSec % 60;
        const pad = (n) => String(n).padStart(2, '0');
        const str = hr > 0 ? `${pad(hr)}:${pad(min)}:${pad(sec)}` : `${pad(min)}:${pad(sec)}`;
        return negative ? `-${str}` : str;
    }

    function formatClock(date) {
        let hr = date.getHours();
        const min = String(date.getMinutes()).padStart(2, '0');
        const ampm = hr >= 12 ? 'PM' : 'AM';
        hr = hr % 12 || 12;
        return `${hr}:${min} ${ampm}`;
    }

    function formatEndTimeDisplay(timeStr) {
        const [ph, pm] = timeStr.split(':').map(Number);
        const ampm = ph >= 12 ? 'PM' : 'AM';
        const hr12 = ph % 12 || 12;
        return `${hr12}:${String(pm).padStart(2, '0')} ${ampm}`;
    }

    // ── Poll server state ──
    async function pollState() {
        try {
            const res = await fetch(config.state_url, {
                headers: { 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
            });
            if (res.ok) {
                const data = await res.json();
                updateClockOffset(data.server_time_ms);
                serverState = data;

                // Update end time if changed from run page
                if (data.end_time_ms) {
                    endTimeMs = data.end_time_ms;
                } else if (data.end_time) {
                    const [ph, pm] = data.end_time.split(':').map(Number);
                    const d = new Date();
                    d.setHours(ph, pm, 0, 0);
                    if (d.getTime() < serverNow() && (!data.status || data.status === 'idle')) {
                        d.setDate(d.getDate() + 1);
                    }
                    endTimeMs = d.getTime();
                }
                if (data.end_time) {
                    endTimeDisplayEl.textContent = formatEndTimeDisplay(data.end_time);
                }

                // Update participant count display
                if (data.total_speakers) {
                    totalParticipantsEl.textContent = data.total_speakers;
                }
            }
        } catch (e) {
            // Silently ignore poll errors
        }
    }

    // ── Render ──
    function render() {
        const now = serverNow();

        // Current time
        currentTimeEl.textContent = formatClock(new Date());

        // Meeting remaining — always computed locally from end time
        const meetingRemaining = endTimeMs - now;
        meetingRemainingEl.textContent = formatTime(meetingRemaining);
        if (meetingRemaining < 0) {
            meetingRemainingEl.classList.add('text-timerbot-red');
        } else {
            meetingRemainingEl.classList.remove('text-timerbot-red');
        }

        // Status badge
        const status = serverState.status || 'idle';
        if (status === 'running') {
            statusBadge.textContent = 'Event is running';
            statusBadge.className = 'text-lg font-semibold text-timerbot-green';
        } else if (status === 'paused') {
            statusBadge.textContent = 'Event is paused';
            statusBadge.className = 'text-lg font-semibold text-timerbot-green';
        } else if (status === 'completed') {
            statusBadge.textContent = 'Event has ended';
            statusBadge.className = 'text-lg font-semibold text-timerbot-red';
        } else {
            statusBadge.textContent = 'Event is not running';
            statusBadge.className = 'text-lg font-semibold text-timerbot-red';
        }

        // Compute speaker remaining (needed for both time-per-participant and speaker section)
        const totalSpeakers = serverState.total_speakers || config.participant_count;
        let speakerRemaining = null;
        let speakerOverTime = false;

        if ((status === 'running' || status === 'paused') && serverState.current_speaker > 0 && serverState.speaker_started_at) {
            const allotted = serverState.speaker_allotted_ms || 0;
            const started  = serverState.speaker_started_at || 0;
            const pausedMs = serverState.total_paused_ms || 0;

            let speakerElapsed;
            if (status === 'paused' && serverState.paused_at) {
                speakerElapsed = serverState.paused_at - started - pausedMs;
            } else {
                speakerElapsed = now - started - pausedMs;
            }
            speakerRemaining = allotted - speakerElapsed;
            speakerOverTime = speakerRemaining < 0;
        }

        // Time per participant — recalculates live when speaker is over time
        if (speakerOverTime) {
            const futureCount = totalSpeakers - serverState.current_speaker;
            if (futureCount > 0) {
                const nextTime = Math.max(0, meetingRemaining / futureCount);
                timePerParticipant.textContent = formatTime(nextTime);
            } else {
                timePerParticipant.textContent = '--:--';
            }
        } else if (status === 'running' && serverState.speaker_allotted_ms) {
            timePerParticipant.textContent = formatTime(serverState.speaker_allotted_ms);
        } else if (status === 'paused') {
            // Show time for future speakers, minus current speaker's reserved time
            // Cap reserved at meeting remaining (speaker can't have more than the meeting has)
            const futureCount = totalSpeakers - serverState.current_speaker;
            const speakerReserved = Math.max(0, Math.min(speakerRemaining || 0, meetingRemaining));
            if (futureCount > 0) {
                const tpp = Math.max(0, (meetingRemaining - speakerReserved) / futureCount);
                timePerParticipant.textContent = formatTime(tpp);
            } else {
                timePerParticipant.textContent = '--:--';
            }
        } else {
            const tpp = totalSpeakers > 0 ? Math.max(0, meetingRemaining / totalSpeakers) : 0;
            timePerParticipant.textContent = formatTime(tpp);
        }

        // Flash red briefly each time the value decrements while over time
        const currentTppText = timePerParticipant.textContent;
        if (speakerOverTime && currentTppText !== lastTppText) {
            lastTppText = currentTppText;
            clearTimeout(tppFlashTimer);
            timePerParticipant.classList.remove('text-timerbot-green');
            timePerParticipant.classList.add('text-timerbot-red');
            tppFlashTimer = setTimeout(() => {
                timePerParticipant.classList.remove('text-timerbot-red');
                timePerParticipant.classList.add('text-timerbot-green');
            }, 500);
        } else if (!speakerOverTime) {
            lastTppText = '';
            clearTimeout(tppFlashTimer);
            timePerParticipant.classList.remove('text-timerbot-red');
            timePerParticipant.classList.add('text-timerbot-green');
        }

        // Speaker section
        if (speakerRemaining !== null) {
            const speaker = serverState.current_speaker;
            const total = totalSpeakers;
            speakerLabel.textContent = `${termSingularUc} ${speaker} of ${total}`;

            // During pause, cap speaker time at meeting remaining
            const effectiveRemain = status === 'paused'
                ? Math.min(speakerRemaining, Math.max(0, meetingRemaining))
                : speakerRemaining;

            speakerTime.textContent = formatTime(effectiveRemain);

            // Color
            speakerTime.classList.remove('text-timerbot-green', 'text-timerbot-red', 'text-text-muted', 'animate-pulse');
            if (effectiveRemain > 0) {
                speakerTime.classList.add('text-timerbot-green');
            } else {
                speakerTime.classList.add('text-timerbot-red', 'animate-pulse');
            }
        } else if (status === 'completed') {
            speakerLabel.textContent = `All ${termPlural} finished`;
            speakerTime.textContent = '00:00';
            speakerTime.className = 'text-7xl md:text-9xl font-bold tabular-nums text-text-muted';
            speakerTime.style.fontFamily = 'var(--font-display)';
        } else {
            speakerLabel.textContent = 'Waiting to start';
            speakerTime.textContent = '--:--';
            speakerTime.className = 'text-7xl md:text-9xl font-bold tabular-nums text-text-muted';
            speakerTime.style.fontFamily = 'var(--font-display)';
        }
    }

    // ── Wake Lock ──
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

    // Re-acquire wake lock when page becomes visible again
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && wakeLockToggle.checked && !wakeLock) {
            requestWakeLock();
        }
    });

    // ── Init ──
    pollState();
    render();

    // Poll every second
    setInterval(pollState, 1000);

    // Render every 200ms for smooth countdown
    setInterval(render, 200);
})();
