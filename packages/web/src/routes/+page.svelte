<script lang="ts">
	import type { PageData } from './$types';

	let { data, form }: { data: PageData; form?: { success?: boolean } } = $props();

	let connected = $state(data.connected);
	let phoneNumber = $state(data.phoneNumber);
	let sessionId = $state(data.sessionId);

	$effect(() => {
		connected = data.connected;
		phoneNumber = data.phoneNumber;
		sessionId = data.sessionId;
	});

	$effect(() => {
		const poll = setInterval(async () => {
			try {
				const response = await fetch('/api/status');
				const status = await response.json();
				connected = status.connected ?? false;
				phoneNumber = status.phoneNumber ?? null;
			} catch {
				// ignore polling errors
			}
		}, 4000);

		return () => clearInterval(poll);
	});
</script>

<div class="flex min-h-[70vh] flex-col items-center justify-center py-8">
	<div class="glass-card w-full max-w-md p-8 text-center animate-fade-up">
		<div class="mb-6">
			<div class="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full" 
			     style="background: var(--gradient-primary);"
			>
				<span class="text-3xl">📱</span>
			</div>
			<p class="text-sm font-medium uppercase tracking-wide" style="color: var(--foreground-subtle);">
				Tu Cuenta
			</p>
			<p class="mt-1 text-3xl font-bold font-display" style="color: var(--foreground);">
				+{data.allowedPhone || 'No configurado'}
			</p>
		</div>

		<div class="border-t border-b py-4 mb-6" style="border-color: var(--card-border);">
			{#if connected}
				<div class="flex items-center justify-center gap-2">
					<div class="status-dot connected"></div>
					<span class="font-medium" style="color: var(--primary-dark);">
						Conectado
					</span>
				</div>
				{#if phoneNumber}
					<p class="mt-1 text-sm" style="color: var(--foreground-muted);">
						{phoneNumber}
					</p>
				{/if}
			{:else}
				<div class="flex items-center justify-center gap-2">
					<div class="status-dot disconnected"></div>
					<span class="font-medium" style="color: #ef4444;">
						Desconectado
					</span>
				</div>
			{/if}
		</div>

		{#if connected}
			<form method="POST">
				<input type="hidden" name="sessionId" value={sessionId ?? ''} />
				<button
					type="submit"
					class="w-full rounded-xl px-4 py-3 text-sm font-semibold text-white transition-all duration-300 hover:scale-[1.02]"
					style="background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%); box-shadow: 0 4px 16px rgba(239, 68, 68, 0.35);"
				>
					<div class="flex items-center justify-center gap-2">
						<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" 
						     stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
							<path d="M18 6 6 18"/><path d="m6 6 12 12"/>
						</svg>
						Desconectar WhatsApp
					</div>
				</button>
			</form>
		{:else}
			<a href="/qr" class="btn-primary inline-flex items-center justify-center gap-2 w-full">
				<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" 
				     stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<rect width="5" height="5" x="3" y="3" rx="1"/><rect width="5" height="5" x="16" y="3" rx="1"/>
					<rect width="5" height="5" x="3" y="16" rx="1"/><path d="M21 16h-3a2 2 0 0 0-2 2v3"/>
					<path d="M21 21v.01"/><path d="M12 7v3a2 2 0 0 1-2 2H7"/><path d="M3 12h.01"/>
					<path d="M12 3h.01"/><path d="M20 4.5a2.5 2.5 0 0 1-2.5 2.5"/><path d="M4.5 20a2.5 2.5 0 0 1 2.5-2.5"/>
				</svg>
				Escanear Código QR
			</a>
		{/if}
	</div>

	{#if form?.success}
		<div class="mt-4 glass-card p-4 text-center" style="background: rgba(34, 197, 94, 0.1); border-color: rgba(34, 197, 94, 0.2);">
			<div class="flex items-center justify-center gap-2" style="color: #16a34a;">
				<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" 
				     stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<path d="M20 6 9 17l-5-5"/>
				</svg>
				<span class="font-medium">Desconectado exitosamente</span>
			</div>
		</div>
	{/if}

	<p class="mt-6 text-center text-sm" style="color: var(--foreground-subtle);">
		Sin logs · Sin almacenamiento · Sin rastros
	</p>
</div>