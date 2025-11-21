// Google Maps API key is injected securely at runtime.
fetch("/api/config")
	.then(res => res.json())
	.then(cfg => {
		window.GMAPS_API_KEY = cfg.GMAPS_API_KEY || "";
		if (!window.GMAPS_API_KEY) {
			console.error("Missing window.GMAPS_API_KEY");
			// Optionally show a user-friendly error
			return;
		}
		// Now that the key is set, initialize the map
		if (typeof initMapAndRun === "function") {
			initMapAndRun();
		}
	})
	.catch(err => {
		console.error("Failed to fetch API key:", err);
	});
