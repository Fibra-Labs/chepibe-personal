<script lang="ts">
	import { goto } from '$app/navigation';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
	
	const QR_EXPIRE_SECONDS = 60;
	let remaining = $state(QR_EXPIRE_SECONDS);
	let polling = $state(true);
	let connected = $state(false);
	
	$effect(() => {
		if (!polling) return;
		
		const countdown = setInterval(() => {
			remaining -= 1;
			
			if (remaining <= 0) {
				clearInterval(countdown);
				window.location.reload();
				return;
			}
		}, 1000);
		
		return () => clearInterval(countdown);
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
</script>

<div class="flex min-h-[70vh] flex-col items-center justify-center py-12">
	{#if data.alreadyConnected}
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
			{#if data.phoneNumber}
				<div class="mt-4 inline-flex items-center gap-2 rounded-full px-4 py-2" 
				     style="background: var(--primary-glow);">
					<span style="color: var(--primary);">📱</span>
					<span class="font-semibold" style="color: var(--primary-dark);">{data.phoneNumber}</span>
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
	{:else if data.qr}
		<!-- QR Code Display -->
		<div class="text-center">
			<div class="badge mb-6" style="background: var(--accent-glow); border-color: rgba(251, 191, 36, 0.2);">
				<span style="color: var(--accent-dark);">⏱️ Expira en {remaining}s</span>
			</div>
			
			<h1 class="font-display text-3xl font-bold" style="color: var(--foreground);">Escanea con WhatsApp</h1>
			<p class="mt-2 max-w-md mx-auto" style="color: var(--foreground-muted);">
				Abre WhatsApp en tu teléfono y escanea este código QR para vincular tu cuenta
			</p>
			
			<div class="mt-8 glass-card p-6 inline-block">
				<img src={data.qr} alt="WhatsApp QR Code" class="h-[280px] w-[280px]" />
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
