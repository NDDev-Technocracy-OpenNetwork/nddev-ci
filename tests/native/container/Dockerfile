FROM nginxinc/nginx-unprivileged@sha256:782bb89768cc87b7f95c18b95baa1af250e5d451f26794f59363540161147c01
USER 0
RUN apk add --no-cache --upgrade \
    brotli-libs=1.2.1-r0 \
    curl=8.23.0-r0 \
    libcurl=8.23.0-r0 \
    libexpat=2.10.0-r0 \
    libx11=1.8.14-r0
LABEL org.nddev.fixture="std0004-native-container"
COPY --chmod=0644 index.html /usr/share/nginx/html/index.html
USER 101:101
EXPOSE 8080
