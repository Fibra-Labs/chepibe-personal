<script lang="ts">
	let { status, message }: { status: number; message: string } = $props();
</script>

<div class="flex min-h-[70vh] flex-col items-center justify-center py-12 text-center">
	<div class="glass-card p-12 max-w-md">
		<div class="mb-6 flex justify-center">
			<div class="flex h-20 w-20 items-center justify-center rounded-full" 
			     style="background: var(--accent-glow);">
				<span class="font-display text-4xl font-bold" style="color: var(--accent-dark);">{status}</span>
			</div>
		</div>
		
		<h1 class="font-display text-2xl font-bold" style="color: var(--foreground);">
			Ups, algo salió mal
		</h1>
		<p class="mt-3" style="color: var(--foreground-muted);">{message}</p>
		
		<a href="/" 
		   class="btn-primary mt-8 inline-flex items-center gap-2">
			<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" 
			     stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
				<path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
				<polyline points="9 22 9 12 15 12 15 22"/>
			</svg>
			Volver al inicio
		</a>
	</div>
</div>
