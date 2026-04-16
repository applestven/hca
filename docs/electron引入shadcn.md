## electron-vite初始化shadcn

初始化之前需要先初始化tailwindcss ，步骤走官网

npm i @radix-ui/react-slot class-variance-authority tailwind-merge

npm i autoprefixer @tailwindcss/forms  -D


## 在渲染目录下renderer/ ，创建 lib/utils.ts
```js
import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

```

## 给目录取别名 

因为npx 添加的shadcn的组件 里面的引用都是使用了别名 ， 又因为这是electron-vite项目 ， 所以需要修改别名

```js
'@m': resolve('src'),
'@': resolve('src/renderer')
```

## 后续如果需要使用界面 就需要从shadcn的组件库里拷贝过来
