FROM nginx:alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY index.html /usr/share/nginx/html/index.html
# install.sh is baked in at image build; update by redeploying the container
# (or bind-mount /usr/share/nginx/html for hot updates)
COPY install.sh /usr/share/nginx/html/install.sh

RUN chmod 0644 /usr/share/nginx/html/install.sh
