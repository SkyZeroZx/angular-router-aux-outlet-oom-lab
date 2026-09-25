FROM nginx:1.31.5-alpine3.24
# Rendered into /etc/nginx/nginx.conf by the image's envsubst entrypoint.
# NGINX_ENVSUBST_FILTER keeps substitution away from Nginx's own $variables.
COPY nginx.conf.template /etc/nginx/templates/nginx.conf.template
