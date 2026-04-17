import { env } from '$env/dynamic/private';

if (!env.ALLOWED_PHONE) {
	console.error('❌ FATAL: ALLOWED_PHONE is required. Set it in .env (country code + number, no + sign, e.g. 5491171234567)');
	process.exit(1);
}

export const config = {
	workerApiUrl: env.WORKER_API_URL!,
	allowedPhone: env.ALLOWED_PHONE
};
