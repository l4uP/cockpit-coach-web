// Small browser helpers for the exercise pages (ADR-110): page visibility and one key listener per running exercise.
window.cockpitCoach = {
    hidden: () => document.hidden,

    // The service worker serves this page: it opens without network.
    offlineReady: () => !!navigator.serviceWorker?.controller,

    // Sends every key press to the page; a key the page used does not reach the browser (no scrolling with Space etc.).
    listenKeys: (page) => {
        const onKey = e => {
            if (e.repeat || e.ctrlKey || e.altKey || e.metaKey) {
                return;
            }

            if (page.invokeMethod('OnKeyDown', e.key)) {
                e.preventDefault();
            }
        };
        document.addEventListener('keydown', onKey);
        return { dispose: () => document.removeEventListener('keydown', onKey) };
    },

    // The finished runs (ADR-110). Storage can be blocked or full: reads give null, writes say whether they worked.
    storage: {
        get: key => {
            try {
                return localStorage.getItem(key);
            } catch {
                return null;
            }
        },
        set: (key, value) => {
            try {
                localStorage.setItem(key, value);
                return true;
            } catch {
                return false;
            }
        },
        remove: key => {
            try {
                localStorage.removeItem(key);
            } catch {
                // nothing stored, nothing to remove
            }
        },
    },

    download: (fileName, text) => {
        const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
        const link = document.createElement('a');
        link.href = url;
        link.download = fileName;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    },

    // Spoken clips (audio/<name>.wav, rendered once with the local SAPI voice): loaded once, played back to back.
    audio: { context: null, buffers: new Map(), playing: [] },

    // Must run inside a click or key press: browsers start sound only after a user gesture.
    unlockAudio: () => {
        const audio = window.cockpitCoach.audio;
        audio.context ??= new AudioContext();
        audio.context.resume().catch(() => { });
    },

    loadClips: async (names) => {
        const audio = window.cockpitCoach.audio;
        audio.context ??= new AudioContext();
        await Promise.all(names.filter(n => !audio.buffers.has(n)).map(async n => {
            const response = await fetch('audio/' + n + '.wav');
            audio.buffers.set(n, await audio.context.decodeAudioData(await response.arrayBuffer()));
        }));
    },

    stopClips: () => {
        const audio = window.cockpitCoach.audio;
        audio.playing.forEach(source => {
            try {
                source.stop();
            } catch {
                // already ended
            }
        });
        audio.playing = [];
    },

    // Re-checks the OFFLINE lamp when the service worker takes over this page (first visit, update).
    watchOffline: (layout) => navigator.serviceWorker?.addEventListener('controllerchange',
        () => layout.invokeMethodAsync('OfflineChanged', !!navigator.serviceWorker.controller)),

    // Plays the clips one after the other with gapSeconds between them; a new call cuts the one still playing off.
    playClips: (names, gapSeconds) => {
        const audio = window.cockpitCoach.audio;
        if (!audio.context) {
            return;
        }

        // After the laptop slept the context may stand still: start it again (the user started the run, so it may).
        if (audio.context.state !== 'running') {
            audio.context.resume().catch(() => { });
        }

        window.cockpitCoach.stopClips();
        let at = audio.context.currentTime + 0.02;
        for (const name of names) {
            const buffer = audio.buffers.get(name);
            if (!buffer) {
                continue;
            }

            const source = audio.context.createBufferSource();
            source.buffer = buffer;
            source.connect(audio.context.destination);
            source.start(at);
            audio.playing.push(source);
            at += buffer.duration + gapSeconds;
        }
    },
};

// Ask the browser to keep the offline copy and the runs even when the disk gets full (installed apps get it at once).
navigator.storage?.persist?.().catch(() => { });
