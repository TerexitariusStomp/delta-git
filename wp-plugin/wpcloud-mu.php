<?php
/**
 * wp-cloud mu-plugin (Lane-3 sites): bridges WP events to the platform agent.
 * - pings the in-container webhook on content changes (sync-out trigger)
 * - exposes a magic-login token endpoint for the dashboard
 * Install: wp-content/mu-plugins/wpcloud-mu.php
 */
defined('ABSPATH') || exit;

add_action('save_post', 'wpc_notify_change');
add_action('activated_plugin', 'wpc_notify_change');
add_action('switch_theme', 'wpc_notify_change');
function wpc_notify_change() {
    // debounce via transient — at most once per 60s
    if (get_transient('wpc_changed')) return;
    set_transient('wpc_changed', 1, 60);
    wp_remote_post('http://localhost:8080/hooks/sync-out', ['timeout' => 2, 'blocking' => false]);
}

add_action('rest_api_init', function () {
    register_rest_route('wpc/v1', '/magic-login', [
        'methods' => 'GET',
        'permission_callback' => function ($req) {
            return hash_equals(get_option('wpc_magic_token', ''), $req->get_param('t') ?? '');
        },
        'callback' => function () {
            $user = get_users(['role' => 'administrator', 'number' => 1])[0] ?? null;
            if (!$user) return new WP_Error('no_admin', 'no admin', ['status' => 404]);
            wp_set_auth_cookie($user->ID);
            return ['redirect' => admin_url()];
        },
    ]);
});
