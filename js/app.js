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
        // "ok", "full" when the quota is used up, "blocked" when the page may not store anything.
        write: (key, value) => {
            try {
                localStorage.setItem(key, value);
                return 'ok';
            } catch (e) {
                return e && (e.name === 'QuotaExceededError' || e.code === 22) ? 'full' : 'blocked';
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

    // While an exercise runs, reloading or closing the window asks first (the run would be lost).
    guardUnload: on => {
        const c = window.cockpitCoach;
        c.running = on; // ADR-121: no update reload during a run
        c.unloadGuard ??= e => { e.preventDefault(); e.returnValue = ''; };
        if (on) {
            window.addEventListener('beforeunload', c.unloadGuard);
        } else {
            window.removeEventListener('beforeunload', c.unloadGuard);
        }
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
        audio.calls = (audio.calls ?? 0) + 1; // a play still waiting for the context gives up
        audio.playing.forEach(source => {
            try {
                source.stop();
            } catch {
                // already ended
            }
        });
        audio.playing = [];
    },

    // ADR-121: updates with a short time online, no new installation. The browser is asked for a new version at the start
    // and whenever the network comes back; the new service worker loads everything and takes over (skipWaiting). Then the
    // app reloads itself – at once on the start page, otherwise as soon as no exercise runs and the start page is shown
    // again – so the new version is there for the next offline use. A first install (no worker before) is no update.
    watchUpdates: registration => {
        const c = window.cockpitCoach;
        const sw = navigator.serviceWorker;
        const update = () => registration.update().catch(() => { });
        update();
        window.addEventListener('online', update);
        const wasControlled = !!sw.controller;
        const atHome = () => new URL(document.baseURI).pathname === location.pathname;
        const reloadWhenFree = () => {
            if (!c.running && atHome()) {
                location.reload();
                return true;
            }

            return false;
        };
        sw.addEventListener('controllerchange', () => {
            if (wasControlled && !c.updatePending) {
                c.updatePending = true;
                if (!reloadWhenFree()) {
                    const timer = setInterval(() => reloadWhenFree() && clearInterval(timer), 2000);
                }
            }
        });
    },

    // Re-checks the OFFLINE lamp when the service worker takes over this page (first visit, update).
    watchOffline: (layout) => navigator.serviceWorker?.addEventListener('controllerchange',
        () => layout.invokeMethodAsync('OfflineChanged', !!navigator.serviceWorker.controller)),

    // Plays the clips one after the other with gapSeconds between them; a new call cuts the one still playing off.
    playClips: async (names, gapSeconds) => {
        const audio = window.cockpitCoach.audio;
        if (!audio.context) {
            return;
        }

        window.cockpitCoach.stopClips();
        const call = audio.calls = audio.calls + 1;

        // After the laptop slept the context may stand still: start it again (the user started the run, so it may) and
        // only then plan the clips, so the first one is not late. At most 0.5 s, then play anyway.
        if (audio.context.state !== 'running') {
            await Promise.race([audio.context.resume().catch(() => { }), new Promise(r => setTimeout(r, 500))]);
            if (call !== audio.calls) {
                return; // a newer call or a stop came meanwhile
            }
        }

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
