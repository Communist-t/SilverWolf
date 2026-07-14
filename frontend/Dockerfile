FROM nginx:alpine

# 拷贝前端静态文件
COPY public /usr/share/nginx/html

# 拷贝 Nginx 配置
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf

# 拷贝入口脚本
COPY frontend/docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

EXPOSE 80

ENTRYPOINT ["/docker-entrypoint.sh"]
