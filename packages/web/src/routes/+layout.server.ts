import { config } from '$lib/server/config';

export const load = async () => {
	return {
		allowedPhone: config.allowedPhone
	};
};
