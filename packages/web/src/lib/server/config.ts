import { env } from '$env/dynamic/private';

export const config = {
	allowedPhone: env.ALLOWED_PHONE!
};
