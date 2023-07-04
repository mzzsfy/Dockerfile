#!/bin/sh

if [ ! -f config.yml ]; then

echo '未找到config.yml 初始化中...'

echo '\n\n' | /app/cqhttp

sed -i '/uin/d' config.yml

sed -i '/password/d' config.yml

if [ ! -z $token ]; then
sed -i "s/access-token: ''/access-token: '$token'/" config.yml
fi

if [ ! -z $ws_url ]; then

s1='  - ws-reverse:\n      universal: '
s2='\n      reconnect-interval: 3000\n      middlewares:\n        <<: *default'

  echo "找到环境变量中的ws地址:$ws_url,将自动设置"
  echo $ws_url | tr ',' '\n' | xargs -n1 -I {} echo -e "$s1{}$s2" >> config.yml
fi

echo "自动化配置完成,如果需要手动操作,请使用 docker attach cq-http 开始交互"
fi


exec /app/cqhttp
