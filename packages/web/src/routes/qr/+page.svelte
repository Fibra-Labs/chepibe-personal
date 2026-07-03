<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { enhance } from '$app/forms';
	import { onMount } from 'svelte';

	const QR_EXPIRE_SECONDS = 60;

	let qrLoadTime = $state(Date.now());
	let currentTime = $state(Date.now());
	let polling = $state(true);
	let connected = $state(false);
	let mode = $state<'qr' | 'pairing'>($page.data.mode === 'pairing' ? 'pairing' : 'qr');
	let submitting = $state(false);
	let formError = $state<string | null>(null);
	let pairingCode = $state<string | null>(null);
	let switching = $state(false);

	let remaining = $derived(
		Math.max(0, QR_EXPIRE_SECONDS - Math.floor((currentTime - qrLoadTime) / 1000))
	);

	$effect(() => {
		if (!polling || !$page.data.qr) return;

		qrLoadTime = Date.now();
		currentTime = Date.now();

		const timer = setInterval(() => {
			currentTime = Date.now();

			if (remaining <= 0) {
				clearInterval(timer);
				window.location.reload();
			}
		}, 1000);

		return () => clearInterval(timer);
	});

	$effect(() => {
		if (connected) return;

		const poll = setInterval(async () => {
			try {
				const response = await fetch('/api/status');
				const status = await response.json();

				if (status.connected) {
					connected = true;
					clearInterval(poll);
					goto('/');
				}
			} catch {
				// ignore polling errors
			}
		}, 2000);

		return () => clearInterval(poll);
	});

	$effect(() => {
		if ($page.form?.pairingError) {
			formError = $page.form.pairingError;
			submitting = false;
			pairingCode = null;
		} else if ($page.form?.pairingCode) {
			pairingCode = $page.form.pairingCode;
			formError = null;
			submitting = false;
		}
	});

	async function handleModeSwitch(newMode: 'qr' | 'pairing') {
		if (newMode === mode) return;
		switching = true;
		mode = newMode;
		formError = null;
		pairingCode = null;
		polling = false;
		qrLoadTime = Date.now();

		const suffix = `_=${Date.now()}`;
		const url = newMode === 'qr'
			? `/qr?${suffix}`
			: `/qr?${suffix}&mode=pairing`;
		window.location.href = url;
	}
</script>

<div class="flex min-h-[70vh] flex-col items-center justify-center py-12">
	{#if $page.data.alreadyConnected}
		<!-- Already Connected State -->
		<div class="glass-card animate-fade-up p-8 text-center max-w-md">
			<div class="mb-4 flex justify-center">
				<div class="flex h-16 w-16 items-center justify-center rounded-full"
				     style="background: var(--primary-glow);">
					<span class="text-3xl">✅</span>
				</div>
			</div>
			<h1 class="font-display text-2xl font-bold" style="color: var(--foreground);">Ya está conectado</h1>
			<p class="mt-2" style="color: var(--foreground-muted);">
				Tu WhatsApp ya está vinculado
			</p>
			{#if $page.data.phoneNumber}
				<div class="mt-4 inline-flex items-center gap-2 rounded-full px-4 py-2"
				     style="background: var(--primary-glow);">
					<span style="color: var(--primary);">📱</span>
					<span class="font-semibold" style="color: var(--primary-dark);">{$page.data.phoneNumber}</span>
				</div>
			{/if}
			<a href="/" class="btn-primary mt-6 inline-flex items-center gap-2">
				Volver al panel
				<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" 
				     stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>
				</svg>
			</a>
		</div>
	{:else}
		<!-- Mode Toggle -->
		<div class="mb-8 inline-flex rounded-lg p-1" style="background: var(--surface-hover); cursor: pointer;">
			<button
				onclick={() => handleModeSwitch('qr')}
				class="rounded-md px-4 py-2 text-sm font-medium transition-colors"
				class:active={mode === 'qr'}
			style={mode === 'qr'
					? 'background: var(--surface); color: var(--foreground); box-shadow: 0 1px 3px rgba(0,0,0,0.1); cursor: pointer;'
					: 'color: var(--foreground-muted); cursor: pointer;'
				}
			>
				Código QR
			</button>
			<button
				onclick={() => handleModeSwitch('pairing')}
				class="rounded-md px-4 py-2 text-sm font-medium transition-colors"
				class:active={mode === 'pairing'}
			style={mode === 'pairing'
					? 'background: var(--surface); color: var(--foreground); box-shadow: 0 1px 3px rgba(0,0,0,0.1); cursor: pointer;'
					: 'color: var(--foreground-muted); cursor: pointer;'
				}
			>
				Código de Emparejamiento
			</button>
		</div>

		{#if mode === 'qr'}
			<!-- QR Code Display -->
			<div class="text-center">
				{#if $page.data.qr}
					<div class="badge mb-6" style="background: var(--accent-glow); border-color: rgba(251, 191, 36, 0.2);">
						<span style="color: var(--accent-dark);">⏱️ Expira en {remaining}s</span>
					</div>

					<h1 class="font-display text-3xl font-bold" style="color: var(--foreground);">Escanea con WhatsApp</h1>
					<p class="mt-2 max-w-md mx-auto" style="color: var(--foreground-muted);">
						Abre WhatsApp en tu teléfono y escanea este código QR para vincular tu cuenta
					</p>

					<div class="mt-8 glass-card p-6 inline-block">
						<img src={$page.data.qr} alt="WhatsApp QR Code" class="h-[280px] w-[280px]" />
					</div>
					
					<div class="mt-6 flex flex-col items-center gap-4">
						<p class="text-sm" style="color: var(--foreground-subtle);">
							El código se recargará automáticamente cuando expire
						</p>
						<button 
							onclick={() => window.location.reload()}
							class="btn-ghost inline-flex items-center gap-2 text-sm">
							<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" 
							     stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
								<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/>
								<path d="M21 3v5h-5"/>
								<path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/>
								<path d="M8 16H3v5"/>
							</svg>
							Recargar ahora
						</button>
					</div>
				{:else}
					<!-- Error State -->
					<div class="glass-card p-8 text-center max-w-md">
						<div class="mb-4 flex justify-center">
							<div class="flex h-16 w-16 items-center justify-center rounded-full" 
							     style="background: rgba(239, 68, 68, 0.1);">
								<span class="text-3xl">⚠️</span>
							</div>
						</div>
						<h1 class="font-display text-xl font-bold" style="color: var(--foreground);">Error al cargar QR</h1>
						<p class="mt-2" style="color: var(--foreground-muted);">
							No se pudo generar el código QR. Intenta de nuevo.
						</p>
						<a href="/qr" class="btn-primary mt-6 inline-flex items-center gap-2">
							<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" 
							     stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
								<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/>
								<path d="M21 3v5h-5"/>
								<path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/>
								<path d="M8 16H3v5"/>
							</svg>
							Reintentar
						</a>
					</div>
				{/if}
			</div>
		{:else}
			<!-- Pairing Code Mode -->
			<div class="text-center">
				{#if pairingCode}
					<!-- Pairing Code Display -->
					<div class="glass-card animate-fade-up p-8 text-center max-w-md">
						<div class="mb-4 flex justify-center">
							<div class="flex h-16 w-16 items-center justify-center rounded-full" 
							     style="background: var(--primary-glow);">
								<span class="text-3xl">🔑</span>
							</div>
						</div>
						<h1 class="font-display text-2xl font-bold" style="color: var(--foreground);">Tu código de emparejamiento</h1>
						
						<div class="my-6">
							<span class="text-5xl font-mono font-bold tracking-[0.3em]" style="color: var(--primary-dark);">
								{pairingCode}
							</span>
						</div>
						
						<div class="mt-4 text-sm" style="color: var(--foreground-muted);">
							<p class="mb-2 font-medium">En tu teléfono:</p>
							<ol class="text-left space-y-1 list-decimal pl-5">
								<li>Abre WhatsApp</li>
								<li>Ve a Dispositivos Vinculados</li>
								<li>Toca "Vincular un dispositivo"</li>
								<li>Ingresa el código de 8 dígitos</li>
							</ol>
						</div>
					</div>
				{:else}
					<!-- Pairing Code Form -->
					<h1 class="font-display text-3xl font-bold" style="color: var(--foreground);">Vincular sin QR</h1>
					<p class="mt-2 max-w-md mx-auto" style="color: var(--foreground-muted);">
						Ingresa tu número de teléfono para recibir un código de emparejamiento
					</p>

						<form
							method="POST"
							use:enhance={() => {
								submitting = true;
								formError = null;
								return async ({ update }) => {
									await update();
									submitting = false;
								};
							}}
							class="mt-8 glass-card p-6 max-w-sm mx-auto"
						>
							<p class="text-sm" style="color: var(--foreground-muted);">
								Se generará un código para el número configurado
							</p>

							{#if formError}
								<div class="mt-4 rounded-lg p-3 text-sm text-left"
								     style="background: rgba(239, 68, 68, 0.1); color: rgb(220, 38, 38);">
									{formError}
								</div>
							{/if}

							<button
								type="submit"
								disabled={submitting}
								class="btn-primary mt-4 w-full inline-flex items-center justify-center gap-2"
							>
								{#if submitting}
									<span>Generando...</span>
								{:else}
									Generar código
									<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none"
									     stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
										<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>
									</svg>
								{/if}
							</button>
						</form>
				{/if}
			</div>
		{/if}
	{/if}
</div>
